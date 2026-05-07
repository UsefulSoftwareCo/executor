import { Effect, Match, Option } from "effect";
import type { Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { GraphqlGroup } from "../api/group";
import { GraphqlExtensionService, GraphqlHandlers } from "../api/handlers";

import {
  definePlugin,
  ScopeId,
  SourceDetectionResult,
  Usage,
  type PluginCtx,
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
import { invokeWithLayer, resolveHeaders } from "./invoke";
import {
  graphqlSchema,
  makeDefaultGraphqlStore,
  type GraphqlStore,
  type StoredGraphqlSource,
  type StoredOperation,
} from "./store";
import {
  ExtractedField,
  type GraphqlSourceAuth,
  OperationBinding,
  type HeaderValue as HeaderValueValue,
  type QueryParamValue,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;

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
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
  /** Query parameters applied to every request. Values can reference secrets. */
  readonly queryParams?: Record<string, QueryParamValue>;
  /** Optional OAuth2 connection used as a Bearer token for every request. */
  readonly auth?: GraphqlSourceAuth;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface GraphqlUpdateSourceInput {
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly queryParams?: Record<string, QueryParamValue>;
  readonly auth?: GraphqlSourceAuth;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): GraphqlConfigEntry => ({
  kind: "graphql",
  endpoint: config.endpoint,
  introspectionJson: config.introspectionJson,
  namespace,
  headers: headersToConfigValues(config.headers),
});

const makeGraphqlExtension = (
  ctx: PluginCtx<GraphqlStore>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
  configFile: ConfigFileSink | undefined,
) => {
  const resolveConfigValues = (values: Record<string, HeaderValue> | undefined) =>
    Effect.gen(function* () {
      if (!values) return undefined;
      const resolved = yield* resolveHeaders(values, ctx.secrets);
      return Object.keys(resolved).length > 0 ? resolved : undefined;
    });

  const resolveOAuthHeader = (auth: GraphqlSourceAuth | undefined) =>
    Effect.gen(function* () {
      if (!auth || auth.kind === "none") return undefined;
      const accessToken = yield* ctx.connections.accessToken(auth.connectionId).pipe(
        Effect.mapError(
          () =>
            new GraphqlIntrospectionError({
              message: `Failed to resolve OAuth connection "${auth.connectionId}"`,
            }),
        ),
      );
      return { Authorization: `Bearer ${accessToken}` };
    });

  const resolveRequestHeaders = (
    headers: Record<string, HeaderValue> | undefined,
    auth: GraphqlSourceAuth | undefined,
  ) =>
    Effect.gen(function* () {
      const resolvedHeaders = yield* resolveConfigValues(headers);
      const oauthHeader = yield* resolveOAuthHeader(auth);
      return { ...(resolvedHeaders ?? {}), ...(oauthHeader ?? {}) };
    });

  const addSourceInternal = (config: GraphqlSourceConfig) =>
    ctx.transaction(
      Effect.gen(function* () {
        let introspectionResult: IntrospectionResult;
        if (config.introspectionJson) {
          introspectionResult = yield* parseIntrospectionJson(config.introspectionJson);
        } else {
          const resolvedHeaders = yield* resolveRequestHeaders(config.headers, config.auth);
          const resolvedQueryParams = yield* resolveConfigValues(config.queryParams);
          introspectionResult = yield* introspect(
            config.endpoint,
            Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
            resolvedQueryParams,
          ).pipe(Effect.provide(httpClientLayer));
        }

        const { result, definitions } = yield* extract(introspectionResult);
        const namespace = config.namespace ?? namespaceFromEndpoint(config.endpoint);
        const prepared = prepareOperations(result.fields, introspectionResult);

        const displayName = config.name?.trim() || namespace;

        const storedSource: StoredGraphqlSource = {
          namespace,
          scope: config.scope,
          name: displayName,
          endpoint: config.endpoint,
          headers: config.headers ?? {},
          queryParams: config.queryParams ?? {},
          auth: config.auth ?? { kind: "none" },
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
            yield* ctx.storage.removeSource(namespace, scope);
            yield* ctx.core.sources.unregister(namespace);
          }),
        );
        if (configFile) {
          yield* configFile.removeSource(namespace);
        }
      }),

    getSource: (namespace: string, scope: string) => ctx.storage.getSource(namespace, scope),

    updateSource: (namespace: string, scope: string, input: GraphqlUpdateSourceInput) =>
      ctx.storage.updateSourceMeta(namespace, scope, {
        name: input.name?.trim() || undefined,
        endpoint: input.endpoint,
        headers: input.headers,
        queryParams: input.queryParams,
        auth: input.auth,
      }),
  };
};

export type GraphqlPluginExtension = ReturnType<typeof makeGraphqlExtension>;

export const graphqlPlugin = definePlugin((options?: GraphqlPluginOptions) => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;

  return {
    id: "graphql" as const,
    packageName: "@executor-js/plugin-graphql",
    schema: graphqlSchema,
    storage: (deps): GraphqlStore => makeDefaultGraphqlStore(deps),

    extension: (ctx) => makeGraphqlExtension(ctx, httpClientLayer, options?.configFile),

    staticSources: (self) => [
      {
        id: "graphql",
        kind: "control",
        name: "GraphQL",
        tools: [
          {
            name: "addSource",
            description: "Add a GraphQL endpoint and register its operations as tools",
            inputSchema: {
              type: "object",
              properties: {
                endpoint: { type: "string" },
                name: { type: "string" },
                introspectionJson: { type: "string" },
                namespace: { type: "string" },
                headers: { type: "object" },
                queryParams: { type: "object" },
                auth: { type: "object" },
              },
              required: ["endpoint"],
            },
            outputSchema: {
              type: "object",
              properties: {
                toolCount: { type: "number" },
              },
              required: ["toolCount"],
            },
            // Static-tool callers don't name a scope. Default to the
            // outermost scope in the executor's stack — for a single-
            // scope executor that's the only scope; for a per-user
            // stack `[user, org]` it writes at `org` so the source is
            // visible across every user.
            handler: ({ ctx, args }) =>
              self.addSource({
                ...(args as Omit<GraphqlSourceConfig, "scope">),
                scope: ctx.scopes.at(-1)!.id,
              }),
          },
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args }) =>
      Effect.gen(function* () {
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

        const resolvedHeaders = yield* resolveHeaders(source.headers, ctx.secrets);
        const resolvedQueryParams = yield* resolveHeaders(source.queryParams, ctx.secrets);
        if (source.auth.kind === "oauth2") {
          const accessToken = yield* ctx.connections.accessToken(source.auth.connectionId);
          resolvedHeaders.Authorization = `Bearer ${accessToken}`;
        }

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

    removeSource: ({ ctx, sourceId, scope }) => ctx.storage.removeSource(sourceId, scope),

    // Look up every place this secret appears across the plugin's two
    // child tables (`graphql_source_header`, `graphql_source_query_param`).
    // The store runs behind the scoped adapter so reads automatically
    // walk the executor's scope stack — no scope arg needed.
    usagesForSecret: ({ ctx, args }) =>
      Effect.gen(function* () {
        // Adapter access via the underlying typed view on the store deps.
        // We thread it through `ctx.storage` rather than re-grabbing it
        // because the store already owns the typed adapter handle; expose
        // a single helper rather than re-implementing the where/joins.
        const headerRows = yield* ctx.storage.findHeaderRowsBySecret(args.secretId);
        const paramRows = yield* ctx.storage.findQueryParamRowsBySecret(args.secretId);

        // Resolve owner names by joining to graphql_source. We batch the
        // distinct (source_id, scope_id) pairs to one findMany rather
        // than N+1 lookups.
        const sourceKeys = new Set<string>();
        for (const r of [...headerRows, ...paramRows]) {
          sourceKeys.add(`${r.scope_id}:${r.source_id}`);
        }
        const sources = yield* ctx.storage.lookupSourceNames([...sourceKeys]);

        const out: Usage[] = [];
        for (const r of headerRows) {
          out.push(
            new Usage({
              pluginId: "graphql",
              scopeId: ScopeId.make(r.scope_id),
              ownerKind: "graphql-source-header",
              ownerId: r.source_id,
              ownerName: sources.get(`${r.scope_id}:${r.source_id}`) ?? null,
              slot: `header:${r.name}`,
            }),
          );
        }
        for (const r of paramRows) {
          out.push(
            new Usage({
              pluginId: "graphql",
              scopeId: ScopeId.make(r.scope_id),
              ownerKind: "graphql-source-query-param",
              ownerId: r.source_id,
              ownerName: sources.get(`${r.scope_id}:${r.source_id}`) ?? null,
              slot: `query_param:${r.name}`,
            }),
          );
        }
        return out;
      }),

    usagesForConnection: ({ ctx, args }) =>
      Effect.gen(function* () {
        // OAuth refs only appear in graphql_source.auth_connection_id —
        // one indexed lookup. No child tables to scan.
        const sources = yield* ctx.storage.findSourcesByConnection(args.connectionId);
        return sources.map(
          (s) =>
            new Usage({
              pluginId: "graphql",
              scopeId: ScopeId.make(s.scope),
              ownerKind: "graphql-source-auth",
              ownerId: s.namespace,
              ownerName: s.name,
              slot: "auth.oauth2",
            }),
        );
      }),

    detect: ({ url }) =>
      Effect.gen(function* () {
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

        if (!ok) return null;

        const name = namespaceFromEndpoint(trimmed);
        return new SourceDetectionResult({
          kind: "graphql",
          confidence: "high",
          endpoint: trimmed,
          name,
          namespace: name,
        });
      }),

    routes: () => GraphqlGroup,
    handlers: () => GraphqlHandlers,
    extensionService: GraphqlExtensionService,
  };
});
