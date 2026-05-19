import { Effect, Match, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  type CredentialBindingRef,
  type CredentialBindingValue,
  definePlugin,
  tool,
  ScopeId,
  SourceDetectionResult,
  StorageError,
  ToolResult,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor-js/sdk/core";
import {
  compileHttpNamedCredentialMap,
  OAuth2SourceConfig,
  httpCredentialInputToBindingValue,
  type HttpConfiguredValueInput,
} from "@executor-js/plugin-http-source/sdk";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type GraphqlSourceConfig as GraphqlConfigEntry,
} from "@executor-js/config";

import {
  introspect,
  parseIntrospectionJson,
  type IntrospectionResult,
  type IntrospectionType,
  type IntrospectionField,
  type IntrospectionTypeRef,
} from "./introspect";
import { extract } from "./extract";
import { GraphqlIntrospectionError, GraphqlInvocationError } from "./errors";
import { invokeWithLayer } from "./invoke";
import {
  graphqlSchema,
  makeDefaultGraphqlStore,
  type GraphqlStore,
  type StoredGraphqlSource,
  type StoredOperation,
} from "./store";
import {
  ExtractedField,
  GraphqlConfiguredValueInput as GraphqlConfiguredValueInputSchema,
  GRAPHQL_OAUTH_CONNECTION_SLOT,
  GraphqlCredentialInput as GraphqlCredentialInputSchema,
  GraphqlSourceAuthInput as GraphqlSourceAuthInputSchema,
  graphqlHeaderSlot,
  graphqlQueryParamSlot,
  OperationBinding,
  type ConfiguredGraphqlCredentialValue,
  type GraphqlConfiguredValueInput,
  type GraphqlCredentialInput,
  type GraphqlSourceAuth,
  type HeaderValue as HeaderValueValue,
  type GraphqlSourceAuthInput,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

const GraphqlErrorBody = Schema.Struct({ message: Schema.String });
const GraphqlErrorsBody = Schema.Array(Schema.Unknown);
const decodeGraphqlErrorBody = Schema.decodeUnknownOption(GraphqlErrorBody);
const decodeGraphqlErrorsBody = Schema.decodeUnknownOption(GraphqlErrorsBody);

const decodeGraphqlErrors = (errors: unknown): readonly unknown[] | undefined =>
  Option.getOrUndefined(decodeGraphqlErrorsBody(errors));

const extractGraphqlErrorMessage = (errors: readonly unknown[]): string | undefined =>
  errors
    .map((error) => Option.getOrUndefined(decodeGraphqlErrorBody(error))?.message)
    .find((message) => message !== undefined && message.length > 0);

export type HeaderValue = HeaderValueValue;
export type GraphqlCredentialValue = ConfiguredGraphqlCredentialValue;

export interface GraphqlSourceConfig {
  /** The GraphQL endpoint URL */
  readonly endpoint: string;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  /** Display name for the source. */
  readonly name: string;
  /** Optional: introspection JSON text (if endpoint doesn't support introspection) */
  readonly introspectionJson?: string;
  /** Namespace for the tools. */
  readonly namespace: string;
  /** Headers applied to every request. Secret entries declare source-owned slots. */
  readonly headers?: Record<string, GraphqlConfiguredValueInput>;
  /** Query parameters applied to every request. Secret entries declare source-owned slots. */
  readonly queryParams?: Record<string, GraphqlConfiguredValueInput>;
  /** Optional OAuth2 credential used as a Bearer token for every request. */
  readonly oauth2?: OAuth2SourceConfig;
  /** Initial credential bindings used while adding and introspecting this source. */
  readonly credentials?: GraphqlInitialCredentialsInput;
}

const GraphqlInitialCredentialsInputSchema = Schema.Struct({
  scope: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  auth: Schema.optional(GraphqlSourceAuthInputSchema),
});
type GraphqlInitialCredentialsInput = typeof GraphqlInitialCredentialsInputSchema.Type;

const StaticAddSourceInputSchema = Schema.Struct({
  scope: Schema.String,
  endpoint: Schema.String,
  name: Schema.String,
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlConfiguredValueInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlConfiguredValueInputSchema)),
  oauth2: Schema.optional(OAuth2SourceConfig),
  credentials: Schema.optional(GraphqlInitialCredentialsInputSchema),
});
const SourceConfigureInputSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  auth: Schema.optional(GraphqlSourceAuthInputSchema),
});

const StaticAddSourceInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(StaticAddSourceInputSchema),
);
const StaticAddSourceOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ toolCount: Schema.Number })),
);

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface GraphqlSourceRef {
  readonly id: string;
  readonly scope: string;
}

export interface GraphqlConfigureSourceInput {
  readonly scope: string;
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, GraphqlCredentialInput>;
  readonly queryParams?: Record<string, GraphqlCredentialInput>;
  readonly auth?: GraphqlSourceAuthInput;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match `token` as a separator-bounded run inside a URL hostname or path,
 *  used as a low-confidence detection hint when introspection fails.
 *  Boundary chars are everything non-alphanumeric, so `/api/graphql`,
 *  `graphql.example.com`, `graphql-api`, and `graphql_v2` all match while
 *  `graphqlserver` and `/graphqlite` do not. */
const urlMatchesToken = (url: URL, token: string): boolean => {
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i");
  return re.test(url.hostname) || re.test(url.pathname);
};

/** Derive a namespace from an endpoint URL */
const namespaceFromEndpoint = (endpoint: string): string => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL construction throws; this helper intentionally falls back to the stable default namespace
  try {
    const url = new URL(endpoint);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "graphql";
  }
};

const formatTypeRef = (ref: IntrospectionTypeRef): string =>
  Match.value(ref.kind).pipe(
    Match.when("NON_NULL", () => (ref.ofType ? `${formatTypeRef(ref.ofType)}!` : "Unknown!")),
    Match.when("LIST", () => (ref.ofType ? `[${formatTypeRef(ref.ofType)}]` : "[Unknown]")),
    Match.option,
    Option.getOrElse(() => ref.name ?? "Unknown"),
  );

const unwrapTypeName = (ref: IntrospectionTypeRef): string => {
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapTypeName(ref.ofType);
  return "Unknown";
};

const buildSelectionSet = (
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
  depth: number,
  seen: Set<string>,
): string => {
  if (depth > 2) return "";

  const leafName = unwrapTypeName(ref);
  if (seen.has(leafName)) return "";

  const objectType = types.get(leafName);
  if (!objectType?.fields) return "";

  const kind = objectType.kind;
  if (kind === "SCALAR" || kind === "ENUM") return "";

  seen.add(leafName);

  const subFields = objectType.fields
    .filter((f) => !f.name.startsWith("__"))
    .slice(0, 12)
    .map((f) => {
      const sub = buildSelectionSet(f.type, types, depth + 1, seen);
      return sub ? `${f.name} ${sub}` : f.name;
    });

  seen.delete(leafName);

  return subFields.length > 0 ? `{ ${subFields.join(" ")} }` : "";
};

const buildOperationStringForField = (
  kind: GraphqlOperationKind,
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
): string => {
  const opType = kind === "query" ? "query" : "mutation";

  const varDefs = field.args.map((arg) => {
    const typeName = formatTypeRef(arg.type);
    return `$${arg.name}: ${typeName}`;
  });

  const argPasses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const selectionSet = buildSelectionSet(field.type, types, 0, new Set());

  const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  const argPassStr = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";

  return `${opType}${varDefsStr} { ${field.name}${argPassStr}${selectionSet ? ` ${selectionSet}` : ""} }`;
};

interface PreparedOperation {
  readonly toolPath: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly binding: OperationBinding;
}

const prepareOperations = (
  fields: readonly ExtractedField[],
  introspection: IntrospectionResult,
): readonly PreparedOperation[] => {
  const typeMap = new Map<string, IntrospectionType>();
  for (const t of introspection.__schema.types) {
    typeMap.set(t.name, t);
  }

  const fieldMap = new Map<string, { kind: GraphqlOperationKind; field: IntrospectionField }>();
  const schema = introspection.__schema;
  for (const rootKind of ["query", "mutation"] as const) {
    const typeName = rootKind === "query" ? schema.queryType?.name : schema.mutationType?.name;
    if (!typeName) continue;
    const rootType = typeMap.get(typeName);
    if (!rootType?.fields) continue;
    for (const f of rootType.fields) {
      if (!f.name.startsWith("__")) {
        fieldMap.set(`${rootKind}.${f.name}`, { kind: rootKind, field: f });
      }
    }
  }

  return fields.map((extracted) => {
    const prefix = extracted.kind === "mutation" ? "mutation" : "query";
    const toolPath = `${prefix}.${extracted.fieldName}`;
    const description = Option.getOrElse(
      extracted.description,
      () => `GraphQL ${extracted.kind}: ${extracted.fieldName} -> ${extracted.returnTypeName}`,
    );

    const key = `${extracted.kind}.${extracted.fieldName}`;
    const entry = fieldMap.get(key);
    const operationString = entry
      ? buildOperationStringForField(entry.kind, entry.field, typeMap)
      : `${extracted.kind} { ${extracted.fieldName} }`;

    const binding = OperationBinding.make({
      kind: extracted.kind,
      fieldName: extracted.fieldName,
      operationString,
      variableNames: extracted.arguments.map((a) => a.name),
    });

    return {
      toolPath,
      description,
      inputSchema: Option.getOrUndefined(extracted.inputSchema),
      binding,
    };
  });
};

const annotationsFor = (binding: OperationBinding): ToolAnnotations => {
  if (binding.kind === "mutation") {
    return {
      requiresApproval: true,
      approvalDescription: `mutation ${binding.fieldName}`,
    };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface GraphqlPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const toGraphqlConfigEntry = (
  namespace: string,
  config: GraphqlSourceConfig,
): GraphqlConfigEntry => {
  const headers: Record<string, HeaderValue> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value === "string" || !("kind" in value)) {
      headers[name] = value;
    }
  }
  return {
    kind: "graphql",
    endpoint: config.endpoint,
    introspectionJson: config.introspectionJson,
    namespace,
    headers: headersToConfigValues(Object.keys(headers).length > 0 ? headers : undefined),
  };
};

const GRAPHQL_PLUGIN_ID = "graphql";

const scopeRanks = (ctx: PluginCtx<GraphqlStore>): ReadonlyMap<string, number> =>
  new Map(ctx.scopes.map((scope, index) => [String(scope.id), index]));

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: string): number =>
  ranks.get(scopeId) ?? Infinity;

const resolveGraphqlSourceBinding = (
  ctx: PluginCtx<GraphqlStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<CredentialBindingRef | null, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return null;
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: GRAPHQL_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    const binding = bindings
      .filter(
        (candidate) =>
          candidate.slotKey === slot && scopeRank(ranks, candidate.scopeId) <= sourceSourceRank,
      )
      .sort((a, b) => scopeRank(ranks, a.scopeId) - scopeRank(ranks, b.scopeId))[0];
    return binding ?? null;
  });

const validateGraphqlBindingTarget = (
  ctx: PluginCtx<GraphqlStore>,
  input: {
    readonly sourceScope: string;
    readonly targetScope: string;
    readonly sourceId: string;
  },
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, input.sourceScope);
    const targetRank = scopeRank(ranks, input.targetScope);
    const scopeList = `[${ctx.scopes.map((s) => s.id).join(", ")}]`;
    if (sourceSourceRank === Infinity) {
      return yield* new StorageError({
        message:
          `GraphQL source binding references source scope "${input.sourceScope}" ` +
          `which is not in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank === Infinity) {
      return yield* new StorageError({
        message:
          `GraphQL source binding targets scope "${input.targetScope}" which is not ` +
          `in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank > sourceSourceRank) {
      return yield* new StorageError({
        message:
          `GraphQL source bindings for "${input.sourceId}" cannot be written at ` +
          `outer scope "${input.targetScope}" because the base source lives at ` +
          `"${input.sourceScope}"`,
        cause: undefined,
      });
    }
  });

const canonicalizeCredentialMap = compileHttpNamedCredentialMap;

const canonicalizeConfiguredValueMap = (
  values: Record<string, GraphqlConfiguredValueInput> | undefined,
  slotForName: (name: string) => string,
): Record<string, ConfiguredGraphqlCredentialValue> => {
  const next: Record<string, ConfiguredGraphqlCredentialValue> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      next[name] = value;
      continue;
    }
    next[name] = {
      kind: "binding",
      slot: slotForName(name),
      prefix: value.prefix,
    };
  }
  return next;
};

const resolveConfiguredValueMap = (
  values: Record<string, HttpConfiguredValueInput> | undefined,
): Record<string, string> | undefined => {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") resolved[name] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

const authFromOAuth2Source = (oauth2: OAuth2SourceConfig | undefined): GraphqlSourceAuth =>
  oauth2 ? { kind: "oauth2", connectionSlot: oauth2.connectionSlot } : { kind: "none" };

const canonicalizeAuth = (
  auth: GraphqlSourceAuthInput | undefined,
): {
  readonly auth: GraphqlSourceAuth;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: CredentialBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  if (!auth || "kind" in auth || !auth.oauth2) return { auth: { kind: "none" }, bindings: [] };
  const connection = auth.oauth2.connection;
  return {
    auth: { kind: "oauth2", connectionSlot: GRAPHQL_OAUTH_CONNECTION_SLOT },
    bindings: connection
      ? [
          {
            slot: GRAPHQL_OAUTH_CONNECTION_SLOT,
            value: httpCredentialInputToBindingValue(connection),
          },
        ]
      : [],
  };
};

const resolveInitialCredentialValueMap = (
  ctx: PluginCtx<GraphqlStore>,
  values: Record<string, ConfiguredGraphqlCredentialValue>,
  bindings: ReadonlyArray<{ readonly slot: string; readonly value: CredentialBindingValue }>,
  targetScope: string,
): Effect.Effect<Record<string, string> | undefined, GraphqlIntrospectionError | StorageFailure> =>
  Effect.gen(function* () {
    const bySlot = new Map(bindings.map((binding) => [binding.slot, binding.value] as const));
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = bySlot.get(value.slot);
      if (binding?.kind === "secret") {
        const secret = yield* ctx.secrets
          .getAtScope(binding.secretId, binding.secretScopeId ?? ScopeId.make(targetScope))
          .pipe(
            Effect.catchTag("SecretOwnedByConnectionError", () =>
              Effect.fail(
                new GraphqlIntrospectionError({
                  message: `Secret not found for ${name}`,
                }),
              ),
            ),
          );
        if (secret === null) {
          return yield* new GraphqlIntrospectionError({
            message: `Missing secret "${binding.secretId}" for ${name}`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.text}` : binding.text;
      }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveInitialOAuthHeaders = (
  ctx: PluginCtx<GraphqlStore>,
  bindings: ReadonlyArray<{ readonly slot: string; readonly value: CredentialBindingValue }>,
  targetScope: string,
): Effect.Effect<Record<string, string> | undefined, GraphqlIntrospectionError | StorageFailure> =>
  Effect.gen(function* () {
    const connection = bindings.find(
      (binding) =>
        binding.slot === GRAPHQL_OAUTH_CONNECTION_SLOT && binding.value.kind === "connection",
    );
    if (!connection || connection.value.kind !== "connection") return undefined;
    const connectionId = connection.value.connectionId;
    const accessToken = yield* ctx.connections
      .accessTokenAtScope(connectionId, ScopeId.make(targetScope))
      .pipe(
        Effect.mapError(
          ({ message }) =>
            new GraphqlIntrospectionError({
              message: `Failed to resolve OAuth connection "${connectionId}": ${message}`,
            }),
        ),
      );
    return { Authorization: `Bearer ${accessToken}` };
  });

const resolveGraphqlBindingValueMap = <E>(
  ctx: PluginCtx<GraphqlStore>,
  values: Record<string, ConfiguredGraphqlCredentialValue> | undefined,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly missingLabel: string;
    readonly makeError: (message: string) => E;
  },
): Effect.Effect<Record<string, string> | undefined, E | StorageFailure> =>
  Effect.gen(function* () {
    if (!values) return undefined;
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = yield* resolveGraphqlSourceBinding(
        ctx,
        params.sourceId,
        params.sourceScope,
        value.slot,
      );
      if (binding?.value.kind === "secret") {
        const secret = yield* ctx.secrets
          .getAtScope(binding.value.secretId, binding.scopeId)
          .pipe(
            Effect.catchTag("SecretOwnedByConnectionError", () =>
              Effect.fail(
                params.makeError(`Secret not found for ${params.missingLabel} "${name}"`),
              ),
            ),
          );
        if (secret === null) {
          return yield* Effect.fail(
            params.makeError(
              `Missing secret "${binding.value.secretId}" for ${params.missingLabel} "${name}"`,
            ),
          );
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      return yield* Effect.fail(
        params.makeError(`Missing binding for ${params.missingLabel} "${name}"`),
      );
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveGraphqlStoredOAuthHeader = (
  ctx: PluginCtx<GraphqlStore>,
  sourceId: string,
  sourceScope: string,
  auth: GraphqlSourceAuth | undefined,
) =>
  Effect.gen(function* () {
    if (!auth || auth.kind === "none") return undefined;
    const binding = yield* resolveGraphqlSourceBinding(
      ctx,
      sourceId,
      sourceScope,
      auth.connectionSlot,
    );
    if (binding?.value.kind !== "connection") {
      return yield* new GraphqlInvocationError({
        message: `Missing OAuth connection binding for GraphQL source "${sourceId}"`,
        statusCode: Option.none(),
      });
    }
    const accessToken = yield* ctx.connections.accessTokenAtScope(
      binding.value.connectionId,
      binding.scopeId,
    );
    return { Authorization: `Bearer ${accessToken}` };
  });

const makeGraphqlExtension = (
  ctx: PluginCtx<GraphqlStore>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  configFile: ConfigFileSink | undefined,
) => {
  const addSourceInternal = (config: GraphqlSourceConfig) =>
    ctx.transaction(
      Effect.gen(function* () {
        const namespace = config.namespace;
        const canonicalHeaders = canonicalizeConfiguredValueMap(config.headers, graphqlHeaderSlot);
        const canonicalQueryParams = canonicalizeConfiguredValueMap(
          config.queryParams,
          graphqlQueryParamSlot,
        );
        const initialHeaders =
          config.credentials?.headers !== undefined
            ? canonicalizeCredentialMap(config.credentials.headers, graphqlHeaderSlot)
            : null;
        const initialQueryParams =
          config.credentials?.queryParams !== undefined
            ? canonicalizeCredentialMap(config.credentials.queryParams, graphqlQueryParamSlot)
            : null;
        const initialAuth =
          config.credentials?.auth !== undefined ? canonicalizeAuth(config.credentials.auth) : null;
        const auth = config.oauth2
          ? authFromOAuth2Source(config.oauth2)
          : (initialAuth?.auth ?? { kind: "none" });
        const initialBindings = [
          ...(initialHeaders?.bindings ?? []),
          ...(initialQueryParams?.bindings ?? []),
          ...(initialAuth?.bindings ?? []),
        ];
        const initialScope = config.credentials?.scope;
        if (initialScope && initialBindings.length > 0) {
          yield* validateGraphqlBindingTarget(ctx, {
            sourceId: namespace,
            sourceScope: config.scope,
            targetScope: initialScope,
          });
        }

        let introspectionResult: IntrospectionResult;
        if (config.introspectionJson) {
          introspectionResult = yield* parseIntrospectionJson(config.introspectionJson);
        } else {
          const resolvedInitialHeaders =
            initialHeaders && initialScope
              ? yield* resolveInitialCredentialValueMap(
                  ctx,
                  canonicalHeaders,
                  initialHeaders.bindings,
                  initialScope,
                )
              : undefined;
          const resolvedOAuthHeaders =
            initialAuth && initialScope
              ? yield* resolveInitialOAuthHeaders(ctx, initialAuth.bindings, initialScope)
              : undefined;
          const resolvedHeaders = {
            ...(resolveConfiguredValueMap(config.headers) ?? {}),
            ...(resolvedInitialHeaders ?? {}),
            ...(resolvedOAuthHeaders ?? {}),
          };
          const resolvedInitialQueryParams =
            initialQueryParams && initialScope
              ? yield* resolveInitialCredentialValueMap(
                  ctx,
                  canonicalQueryParams,
                  initialQueryParams.bindings,
                  initialScope,
                )
              : undefined;
          const resolvedQueryParams = {
            ...(resolveConfiguredValueMap(config.queryParams) ?? {}),
            ...(resolvedInitialQueryParams ?? {}),
          };
          introspectionResult = yield* introspect(
            config.endpoint,
            Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
            Object.keys(resolvedQueryParams).length > 0 ? resolvedQueryParams : undefined,
          ).pipe(Effect.provide(httpClientLayer));
        }

        const { result, definitions } = yield* extract(introspectionResult);
        const prepared = prepareOperations(result.fields, introspectionResult);

        const displayName = config.name?.trim() || namespace;

        const storedSource: StoredGraphqlSource = {
          namespace,
          scope: config.scope,
          name: displayName,
          endpoint: config.endpoint,
          headers: canonicalHeaders,
          queryParams: canonicalQueryParams,
          auth,
        };

        const storedOps: StoredOperation[] = prepared.map((p) => ({
          toolId: `${namespace}.${p.toolPath}`,
          sourceId: namespace,
          binding: p.binding,
        }));

        yield* ctx.storage.upsertSource(storedSource, storedOps);
        yield* ctx.core.sources.register({
          id: namespace,
          scope: config.scope,
          kind: "graphql",
          name: displayName,
          url: config.endpoint,
          canRemove: true,
          canRefresh: false,
          canEdit: true,
          tools: prepared.map((p) => ({
            name: p.toolPath,
            description: p.description,
            inputSchema: p.inputSchema,
          })),
        });
        if (initialScope && initialBindings.length > 0) {
          yield* ctx.credentialBindings.replaceForSource({
            targetScope: ScopeId.make(initialScope),
            pluginId: GRAPHQL_PLUGIN_ID,
            sourceId: namespace,
            sourceScope: ScopeId.make(config.scope),
            slotPrefixes: [
              ...(config.credentials?.headers !== undefined ? ["header:"] : []),
              ...(config.credentials?.queryParams !== undefined ? ["query_param:"] : []),
              ...(config.credentials?.auth !== undefined ? ["auth:"] : []),
            ],
            bindings: initialBindings.map((binding) => ({
              slotKey: binding.slot,
              value: binding.value,
            })),
          });
        }

        if (Object.keys(definitions).length > 0) {
          yield* ctx.core.definitions.register({
            sourceId: namespace,
            scope: config.scope,
            definitions,
          });
        }

        return { toolCount: prepared.length, namespace };
      }),
    );

  const configureSource = (
    namespace: string,
    scope: string,
    targetScope: string,
    input: Omit<GraphqlConfigureSourceInput, "scope">,
  ) =>
    Effect.gen(function* () {
      const existing = yield* ctx.storage.getSource(namespace, scope);
      if (!existing) return;
      const canonicalHeaders =
        input.headers !== undefined
          ? canonicalizeCredentialMap(input.headers, graphqlHeaderSlot)
          : null;
      const canonicalQueryParams =
        input.queryParams !== undefined
          ? canonicalizeCredentialMap(input.queryParams, graphqlQueryParamSlot)
          : null;
      const canonicalAuth = input.auth !== undefined ? canonicalizeAuth(input.auth) : null;
      const directBindings = [
        ...(canonicalHeaders?.bindings ?? []),
        ...(canonicalQueryParams?.bindings ?? []),
        ...(canonicalAuth?.bindings ?? []),
      ];
      if (directBindings.length > 0) {
        yield* validateGraphqlBindingTarget(ctx, {
          sourceId: namespace,
          sourceScope: scope,
          targetScope,
        });
      }
      const affectedPrefixes = [
        ...(input.headers !== undefined ? ["header:"] : []),
        ...(input.queryParams !== undefined ? ["query_param:"] : []),
        ...(input.auth !== undefined ? ["auth:"] : []),
      ];
      yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.updateSourceMeta(namespace, scope, {
            name: input.name?.trim() || undefined,
            endpoint: input.endpoint,
            headers: canonicalHeaders?.values,
            queryParams: canonicalQueryParams?.values,
            auth: canonicalAuth?.auth,
          });
          if (affectedPrefixes.length > 0 || directBindings.length > 0) {
            yield* ctx.credentialBindings.replaceForSource({
              targetScope: ScopeId.make(targetScope),
              pluginId: GRAPHQL_PLUGIN_ID,
              sourceId: namespace,
              sourceScope: ScopeId.make(scope),
              slotPrefixes: affectedPrefixes,
              bindings: directBindings.map((binding) => ({
                slotKey: binding.slot,
                value: binding.value,
              })),
            });
          }
        }),
      );
    });

  return {
    addSource: (config: GraphqlSourceConfig) =>
      addSourceInternal(config).pipe(
        Effect.tap((result) =>
          configFile
            ? configFile.upsertSource(toGraphqlConfigEntry(result.namespace, config))
            : Effect.void,
        ),
      ),

    removeSource: (namespace: string, scope: string) =>
      Effect.gen(function* () {
        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.credentialBindings.removeForSource({
              pluginId: GRAPHQL_PLUGIN_ID,
              sourceId: namespace,
              sourceScope: ScopeId.make(scope),
            });
            yield* ctx.storage.removeSource(namespace, scope);
            yield* ctx.core.sources.unregister({ id: namespace, targetScope: scope });
          }),
        );
        if (configFile) {
          yield* configFile.removeSource(namespace);
        }
      }),

    getSource: (namespace: string, scope: string) => ctx.storage.getSource(namespace, scope),

    configureSource,

    configure: (source: GraphqlSourceRef, input: GraphqlConfigureSourceInput) =>
      configureSource(source.id, source.scope, input.scope, input),
  };
};

export type GraphqlPluginExtension = ReturnType<typeof makeGraphqlExtension>;

export const graphqlPlugin = definePlugin((options?: GraphqlPluginOptions) => {
  return {
    id: "graphql" as const,
    packageName: "@executor-js/plugin-graphql",
    schema: graphqlSchema,
    storage: (deps): GraphqlStore => makeDefaultGraphqlStore(deps),

    extension: (ctx) =>
      makeGraphqlExtension(
        ctx,
        options?.httpClientLayer ?? ctx.httpClientLayer,
        options?.configFile,
      ),

    sourceConfigure: {
      type: "graphql",
      schema: SourceConfigureInputSchema,
      configure: ({ ctx, sourceId, sourceScope, targetScope, config }) =>
        makeGraphqlExtension(
          ctx,
          options?.httpClientLayer ?? ctx.httpClientLayer,
          options?.configFile,
        ).configureSource(
          sourceId,
          sourceScope,
          targetScope,
          config as GraphqlConfigureSourceInput,
        ),
    },

    staticSources: (self) => [
      {
        id: "graphql",
        kind: "executor",
        name: "GraphQL",
        tools: [
          tool({
            name: "addSource",
            description: "Add a GraphQL endpoint and register its operations as tools",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add a GraphQL source",
            },
            inputSchema: StaticAddSourceInputStandardSchema,
            outputSchema: StaticAddSourceOutputStandardSchema,
            execute: (input) => Effect.map(self.addSource(input), ToolResult.ok),
          }),
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        // toolRow.scope_id is the resolved owning scope of the tool
        // (innermost-wins from the executor's stack). The matching
        // GraphQL operation + source plugin-storage rows live at the same
        // scope, so pin every store lookup to it instead of relying on
        // stack-wide scope fall-through.
        const toolScope = toolRow.scope_id;
        const op = yield* ctx.storage.getOperationByToolId(toolRow.id, toolScope);
        if (!op) {
          return yield* new GraphqlInvocationError({
            message: `No GraphQL operation found for tool "${toolRow.id}"`,
            statusCode: Option.none(),
          });
        }
        const source = yield* ctx.storage.getSource(op.sourceId, toolScope);
        if (!source) {
          return yield* new GraphqlInvocationError({
            message: `No GraphQL source found for "${op.sourceId}"`,
            statusCode: Option.none(),
          });
        }

        const resolvedHeaders =
          (yield* resolveGraphqlBindingValueMap(ctx, source.headers, {
            sourceId: source.namespace,
            sourceScope: source.scope,
            missingLabel: "header",
            makeError: (message) =>
              new GraphqlInvocationError({ message, statusCode: Option.none() }),
          })) ?? {};
        const resolvedQueryParams =
          (yield* resolveGraphqlBindingValueMap(ctx, source.queryParams, {
            sourceId: source.namespace,
            sourceScope: source.scope,
            missingLabel: "query parameter",
            makeError: (message) =>
              new GraphqlInvocationError({ message, statusCode: Option.none() }),
          })) ?? {};
        const oauthHeader = yield* resolveGraphqlStoredOAuthHeader(
          ctx,
          source.namespace,
          source.scope,
          source.auth,
        );
        Object.assign(resolvedHeaders, oauthHeader ?? {});

        const result = yield* invokeWithLayer(
          op.binding,
          (args ?? {}) as Record<string, unknown>,
          source.endpoint,
          resolvedHeaders,
          resolvedQueryParams,
          httpClientLayer,
        );

        const errors = decodeGraphqlErrors(result.errors);
        if (errors !== undefined && errors.length > 0) {
          const firstMessage = extractGraphqlErrorMessage(errors);
          return ToolResult.fail({
            code: "graphql_errors",
            message: firstMessage !== undefined ? firstMessage : "GraphQL request returned errors",
            details: { errors },
          });
        }
        if (result.status < 200 || result.status >= 300) {
          return ToolResult.fail({
            code: "graphql_http_error",
            status: result.status,
            message: `GraphQL request failed with HTTP ${result.status}`,
            details: {
              status: result.status,
              data: result.data,
              errors: result.errors,
            },
          });
        }
        return ToolResult.ok(result.data);
      }),

    resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
      Effect.gen(function* () {
        // toolRows for a single (plugin_id, source_id) group can still
        // straddle multiple scopes when the source is shadowed (e.g. an
        // org-level GraphQL source plus a per-user override that
        // re-registers the same tool ids). Run one listOperationsBySource
        // per distinct scope so each lookup pins {source_id, scope_id}
        // and we don't fall through to the wrong scope's bindings.
        const scopes = new Set<string>();
        for (const row of toolRows as readonly ToolRow[]) {
          scopes.add(row.scope_id);
        }
        // One listOperationsBySource per scope is independent storage
        // work; run them in parallel so a shadowed source doesn't
        // serialise two ~200ms reads back-to-back in the caller's
        // `executor.tools.list.annotations` span.
        const entries = yield* Effect.forEach(
          [...scopes],
          (scope) =>
            Effect.gen(function* () {
              const ops = yield* ctx.storage.listOperationsBySource(sourceId, scope);
              const byId = new Map<string, OperationBinding>();
              for (const op of ops) byId.set(op.toolId, op.binding);
              return [scope, byId] as const;
            }),
          { concurrency: "unbounded" },
        );
        const byScope = new Map<string, Map<string, OperationBinding>>(entries);

        const out: Record<string, ToolAnnotations> = {};
        for (const row of toolRows as readonly ToolRow[]) {
          const binding = byScope.get(row.scope_id)?.get(row.id);
          if (binding) out[row.id] = annotationsFor(binding);
        }
        return out;
      }),

    removeSource: ({ ctx, sourceId, scope }) =>
      Effect.gen(function* () {
        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.credentialBindings.removeForSource({
              pluginId: GRAPHQL_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(scope),
            });
            yield* ctx.storage.removeSource(sourceId, scope);
          }),
        );
        if (options?.configFile) {
          yield* options.configFile.removeSource(sourceId);
        }
      }),

    usagesForSecret: () => Effect.succeed([]),

    usagesForConnection: () => Effect.succeed([]),

    detect: ({ ctx, url }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed) return null;
        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (cause) => cause,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return null;

        const ok = yield* introspect(trimmed).pipe(
          Effect.provide(httpClientLayer),
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );

        const name = namespaceFromEndpoint(trimmed);

        if (ok) {
          return SourceDetectionResult.make({
            kind: "graphql",
            confidence: "high",
            endpoint: trimmed,
            name,
            namespace: name,
          });
        }

        // Low-confidence URL-token fallback. Introspection can fail for
        // many reasons (auth, CORS, the endpoint disabled introspection
        // in production, transport errors). When the URL itself
        // strongly implies GraphQL, surface a candidate so the user
        // can still pick it from the detect dropdown.
        if (urlMatchesToken(parsed.value, "graphql")) {
          return SourceDetectionResult.make({
            kind: "graphql",
            confidence: "low",
            endpoint: trimmed,
            name,
            namespace: name,
          });
        }

        return null;
      }),
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-graphql/api`. Hosts that
  // want the HTTP surface import the plugin from there; SDK-only
  // consumers stay on this entry and avoid the server-only deps.
});
