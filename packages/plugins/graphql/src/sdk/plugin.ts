import { Effect, Match, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { GraphqlGroup } from "../api/group";
import { GraphqlExtensionService, GraphqlHandlers } from "../api/handlers";

import {
  ConnectionId,
  ConfiguredCredentialBinding,
  type CredentialBindingRef,
  definePlugin,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  StorageError,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor-js/sdk/core";

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
  GRAPHQL_OAUTH_CONNECTION_SLOT,
  GraphqlCredentialInput as GraphqlCredentialInputSchema,
  GraphqlSourceAuthInput as GraphqlSourceAuthInputSchema,
  GraphqlSourceBindingInput,
  GraphqlSourceBindingRef,
  graphqlHeaderSlot,
  graphqlQueryParamSlot,
  OperationBinding,
  type ConfiguredGraphqlCredentialValue,
  type GraphqlCredentialInput,
  type GraphqlSourceAuth,
  type HeaderValue as HeaderValueValue,
  type GraphqlSourceAuthInput,
  type GraphqlSourceBindingValue,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

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
  /** Display name for the source. Falls back to namespace if not provided. */
  readonly name?: string;
  /** Optional: introspection JSON text (if endpoint doesn't support introspection) */
  readonly introspectionJson?: string;
  /** Namespace for the tools (derived from endpoint if not provided) */
  readonly namespace?: string;
  /** Headers applied to every request. Direct secrets are rewritten to slots. */
  readonly headers?: Record<string, GraphqlCredentialInput>;
  /** Query parameters applied to every request. Direct secrets are rewritten to slots. */
  readonly queryParams?: Record<string, GraphqlCredentialInput>;
  /**
   * Scope that owns any direct credentials supplied on this call. Required
   * whenever headers/queryParams/auth carry direct secret or connection ids.
   */
  readonly credentialTargetScope?: string;
  /** Optional OAuth2 credential used as a Bearer token for every request. */
  readonly auth?: GraphqlSourceAuthInput;
}

const StaticAddSourceInputSchema = Schema.Struct({
  scope: Schema.String,
  endpoint: Schema.String,
  name: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, GraphqlCredentialInputSchema)),
  credentialTargetScope: Schema.optional(Schema.String),
  auth: Schema.optional(GraphqlSourceAuthInputSchema),
});

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface GraphqlUpdateSourceInput {
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, GraphqlCredentialInput>;
  readonly queryParams?: Record<string, GraphqlCredentialInput>;
  readonly credentialTargetScope?: string;
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

    const binding = new OperationBinding({
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

const coreBindingToGraphqlBinding = (binding: CredentialBindingRef): GraphqlSourceBindingRef =>
  new GraphqlSourceBindingRef({
    sourceId: binding.sourceId,
    sourceScopeId: binding.sourceScopeId,
    scopeId: binding.scopeId,
    slot: binding.slotKey,
    value: binding.value,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });

const listGraphqlSourceBindings = (
  ctx: PluginCtx<GraphqlStore>,
  sourceId: string,
  sourceScope: string,
): Effect.Effect<readonly GraphqlSourceBindingRef[], StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return [];
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: GRAPHQL_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    return bindings
      .filter((binding) => scopeRank(ranks, binding.scopeId) <= sourceSourceRank)
      .map(coreBindingToGraphqlBinding);
  });

const resolveGraphqlSourceBinding = (
  ctx: PluginCtx<GraphqlStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<GraphqlSourceBindingRef | null, StorageFailure> =>
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
    return binding ? coreBindingToGraphqlBinding(binding) : null;
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

const bindingTargetScope = (
  targetScope: string | undefined,
  bindings: readonly unknown[],
): Effect.Effect<string | undefined, GraphqlIntrospectionError> => {
  if (bindings.length === 0) return Effect.succeed(undefined);
  if (targetScope) return Effect.succeed(targetScope);
  return Effect.fail(
    new GraphqlIntrospectionError({
      message: "credentialTargetScope is required when adding direct GraphQL credentials",
    }),
  );
};

const targetScopeForBinding = (
  fallbackTargetScope: string | undefined,
  binding: { readonly targetScope?: string },
): Effect.Effect<string, GraphqlIntrospectionError> => {
  const targetScope = binding.targetScope ?? fallbackTargetScope;
  if (targetScope) return Effect.succeed(targetScope);
  return Effect.fail(
    new GraphqlIntrospectionError({
      message: "credentialTargetScope is required when adding direct GraphQL credentials",
    }),
  );
};

const canonicalizeCredentialMap = (
  values: Record<string, GraphqlCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredGraphqlCredentialValue>;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: GraphqlSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  const nextValues: Record<string, ConfiguredGraphqlCredentialValue> = {};
  const bindings: Array<{
    slot: string;
    value: GraphqlSourceBindingValue;
    targetScope?: string;
  }> = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if ("kind" in value) {
      nextValues[name] = value;
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = new ConfiguredCredentialBinding({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      targetScope: "targetScope" in value ? value.targetScope : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: value.secretScopeId }
          : {}),
      },
    });
  }
  return { values: nextValues, bindings };
};

const canonicalizeAuth = (
  auth: GraphqlSourceAuthInput | undefined,
): {
  readonly auth: GraphqlSourceAuth;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: GraphqlSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  if (!auth || auth.kind === "none") return { auth: { kind: "none" }, bindings: [] };
  if ("connectionSlot" in auth) return { auth, bindings: [] };
  return {
    auth: { kind: "oauth2", connectionSlot: GRAPHQL_OAUTH_CONNECTION_SLOT },
    bindings: [
      {
        slot: GRAPHQL_OAUTH_CONNECTION_SLOT,
        value: {
          kind: "connection",
          connectionId: ConnectionId.make(auth.connectionId),
        },
      },
    ],
  };
};

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
  const resolveCredentialInputMap = <E>(
    values: Record<string, GraphqlCredentialInput> | undefined,
    params: {
      readonly sourceId: string;
      readonly sourceScope: string;
      readonly targetScope?: string;
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
        if ("kind" in value) {
          const slotResolved = yield* resolveGraphqlBindingValueMap(
            ctx,
            { [name]: value },
            {
              sourceId: params.sourceId,
              sourceScope: params.sourceScope,
              missingLabel: params.missingLabel,
              makeError: params.makeError,
            },
          );
          if (slotResolved?.[name] !== undefined) resolved[name] = slotResolved[name];
          continue;
        }
        const secretScope =
          "secretScopeId" in value
            ? (value.secretScopeId ?? value.targetScope)
            : (params.targetScope ?? params.sourceScope);
        const secret = yield* ctx.secrets
          .getAtScope(SecretId.make(value.secretId), secretScope)
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
              `Missing secret "${value.secretId}" for ${params.missingLabel} "${name}"`,
            ),
          );
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
      }
      return Object.keys(resolved).length > 0 ? resolved : undefined;
    });

  const resolveOAuthInputHeader = (
    sourceId: string,
    sourceScope: string,
    targetScope: string | undefined,
    auth: GraphqlSourceAuthInput | undefined,
  ) =>
    Effect.gen(function* () {
      if (!auth || auth.kind === "none") return undefined;
      const connection =
        "connectionId" in auth
          ? { id: auth.connectionId, scope: targetScope ?? sourceScope }
          : yield* Effect.gen(function* () {
              const binding = yield* resolveGraphqlSourceBinding(
                ctx,
                sourceId,
                sourceScope,
                auth.connectionSlot,
              );
              return binding?.value.kind === "connection"
                ? { id: binding.value.connectionId, scope: binding.scopeId }
                : null;
            });
      if (connection === null) {
        return yield* new GraphqlIntrospectionError({
          message: `Missing OAuth connection binding for "${sourceId}"`,
        });
      }
      const accessToken = yield* ctx.connections
        .accessTokenAtScope(connection.id, connection.scope)
        .pipe(
          Effect.mapError(
            () =>
              new GraphqlIntrospectionError({
                message: `Failed to resolve OAuth connection "${connection.id}"`,
              }),
          ),
        );
      return { Authorization: `Bearer ${accessToken}` };
    });

  const addSourceInternal = (config: GraphqlSourceConfig) =>
    ctx.transaction(
      Effect.gen(function* () {
        const namespace = config.namespace ?? namespaceFromEndpoint(config.endpoint);
        const canonicalHeaders = canonicalizeCredentialMap(config.headers, graphqlHeaderSlot);
        const canonicalQueryParams = canonicalizeCredentialMap(
          config.queryParams,
          graphqlQueryParamSlot,
        );
        const canonicalAuth = canonicalizeAuth(config.auth);
        const directBindings = [
          ...canonicalHeaders.bindings,
          ...canonicalQueryParams.bindings,
          ...canonicalAuth.bindings,
        ];
        for (const binding of directBindings) {
          const bindingTargetScope = yield* targetScopeForBinding(
            config.credentialTargetScope,
            binding,
          );
          yield* validateGraphqlBindingTarget(ctx, {
            sourceId: namespace,
            sourceScope: config.scope,
            targetScope: bindingTargetScope,
          });
        }
        const targetScope =
          directBindings[0] !== undefined
            ? yield* targetScopeForBinding(config.credentialTargetScope, directBindings[0])
            : undefined;

        let introspectionResult: IntrospectionResult;
        if (config.introspectionJson) {
          introspectionResult = yield* parseIntrospectionJson(config.introspectionJson);
        } else {
          const resolvedHeaders = yield* resolveCredentialInputMap(config.headers, {
            sourceId: namespace,
            sourceScope: config.scope,
            targetScope,
            missingLabel: "header",
            makeError: (message) => new GraphqlIntrospectionError({ message }),
          });
          const oauthHeader = yield* resolveOAuthInputHeader(
            namespace,
            config.scope,
            targetScope,
            config.auth,
          );
          const resolvedQueryParams = yield* resolveCredentialInputMap(config.queryParams, {
            sourceId: namespace,
            sourceScope: config.scope,
            targetScope,
            missingLabel: "query parameter",
            makeError: (message) => new GraphqlIntrospectionError({ message }),
          });
          introspectionResult = yield* introspect(
            config.endpoint,
            { ...(resolvedHeaders ?? {}), ...(oauthHeader ?? {}) },
            resolvedQueryParams,
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
          headers: canonicalHeaders.values,
          queryParams: canonicalQueryParams.values,
          auth: canonicalAuth.auth,
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

        if (Object.keys(definitions).length > 0) {
          yield* ctx.core.definitions.register({
            sourceId: namespace,
            scope: config.scope,
            definitions,
          });
        }

        if (directBindings.length > 0) {
          for (const binding of directBindings) {
            const bindingTargetScope = yield* targetScopeForBinding(
              config.credentialTargetScope,
              binding,
            );
            yield* ctx.credentialBindings.set({
              targetScope: ScopeId.make(bindingTargetScope),
              pluginId: GRAPHQL_PLUGIN_ID,
              sourceId: namespace,
              sourceScope: ScopeId.make(config.scope),
              slotKey: binding.slot,
              value: binding.value,
            });
          }
        }

        return { toolCount: prepared.length, namespace };
      }),
    );

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

    updateSource: (namespace: string, scope: string, input: GraphqlUpdateSourceInput) =>
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
        const targetScope = yield* bindingTargetScope(input.credentialTargetScope, directBindings);
        if (targetScope) {
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
        const replacementTargetScope = targetScope ?? input.credentialTargetScope ?? scope;
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
                targetScope: ScopeId.make(replacementTargetScope),
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
      }),

    listSourceBindings: (sourceId: string, sourceScope: string) =>
      listGraphqlSourceBindings(ctx, sourceId, sourceScope),

    setSourceBinding: (input: GraphqlSourceBindingInput) =>
      Effect.gen(function* () {
        yield* validateGraphqlBindingTarget(ctx, {
          sourceId: input.sourceId,
          sourceScope: input.sourceScope,
          targetScope: input.scope,
        });
        const binding = yield* ctx.credentialBindings.set({
          targetScope: input.scope,
          pluginId: GRAPHQL_PLUGIN_ID,
          sourceId: input.sourceId,
          sourceScope: input.sourceScope,
          slotKey: input.slot,
          value: input.value,
        });
        return coreBindingToGraphqlBinding(binding);
      }),

    removeSourceBinding: (sourceId: string, sourceScope: string, slot: string, scope: string) =>
      Effect.gen(function* () {
        yield* validateGraphqlBindingTarget(ctx, {
          sourceId,
          sourceScope,
          targetScope: scope,
        });
        yield* ctx.credentialBindings.remove({
          targetScope: ScopeId.make(scope),
          pluginId: GRAPHQL_PLUGIN_ID,
          sourceId,
          sourceScope: ScopeId.make(sourceScope),
          slotKey: slot,
        });
      }),
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

    staticSources: (self) => [
      {
        id: "graphql",
        kind: "control",
        name: "GraphQL",
        tools: [
          {
            name: "addSource",
            description: "Add a GraphQL endpoint and register its operations as tools",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add a GraphQL source",
            },
            inputSchema: {
              type: "object",
              properties: {
                scope: { type: "string" },
                endpoint: { type: "string" },
                name: { type: "string" },
                introspectionJson: { type: "string" },
                namespace: { type: "string" },
                headers: { type: "object" },
                queryParams: { type: "object" },
                credentialTargetScope: { type: "string" },
                auth: { type: "object" },
              },
              required: ["scope", "endpoint"],
            },
            outputSchema: {
              type: "object",
              properties: {
                toolCount: { type: "number" },
              },
              required: ["toolCount"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(StaticAddSourceInputSchema)(args);
                return yield* self.addSource(input);
              }),
          },
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        // toolRow.scope_id is the resolved owning scope of the tool
        // (innermost-wins from the executor's stack). The matching
        // graphql_operation + graphql_source rows live at the same
        // scope, so pin every store lookup to it instead of relying
        // on the scoped adapter's stack-wide fall-through.
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

        return result;
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
          return new SourceDetectionResult({
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
          return new SourceDetectionResult({
            kind: "graphql",
            confidence: "low",
            endpoint: trimmed,
            name,
            namespace: name,
          });
        }

        return null;
      }),

    routes: () => GraphqlGroup,
    handlers: () => GraphqlHandlers,
    extensionService: GraphqlExtensionService,
  };
});
