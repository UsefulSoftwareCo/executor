import { Effect, Option, Predicate, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import { OpenApiGroup } from "../api/group";
import { OpenApiExtensionService, OpenApiHandlers } from "../api/handlers";

import {
  ScopeId,
  SecretId,
  SourceDetectionResult,
  StorageError,
  definePlugin,
  resolveSecretBackedMap,
  type CredentialBindingRef,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor-js/sdk/core";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type OpenApiSourceConfig,
} from "@executor-js/config";

import { OpenApiExtractionError, OpenApiOAuthError, OpenApiParseError } from "./errors";
import { parse, resolveSpecText } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { annotationsForOperation, invokeWithLayer } from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import { previewSpec, SpecPreview } from "./preview";
import {
  makeDefaultOpenapiStore,
  openapiSchema,
  type OpenapiStore,
  type SourceConfig,
  type StoredOperation,
  type StoredSource,
} from "./store";
import {
  HeaderValue as HeaderValueSchema,
  ConfiguredHeaderValue as ConfiguredHeaderValueSchema,
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OpenApiCredentialInput as OpenApiCredentialInputSchema,
  OpenApiSourceBindingInput,
  OpenApiSourceBindingRef,
  type OpenApiCredentialInput as OpenApiCredentialInputValue,
  type OpenApiSourceBindingValue,
  OperationBinding,
  type ConfiguredHeaderValue as ConfiguredHeaderValueValue,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;
export type ConfiguredHeaderValue = ConfiguredHeaderValueValue;
export type OpenApiHeaderInput = HeaderValue | ConfiguredHeaderValue;
export type OpenApiCredentialInput = OpenApiCredentialInputValue;
export type OpenApiOAuthInput = OAuth2SourceConfig;

export interface OpenApiSpecFetchCredentialsInput {
  readonly headers?: Record<string, HeaderValue>;
  readonly queryParams?: Record<string, HeaderValue>;
}

export interface OpenApiPreviewInput {
  readonly spec: string;
  readonly specFetchCredentials?: OpenApiSpecFetchCredentialsInput;
}

export interface OpenApiSpecConfig {
  readonly spec: string;
  readonly specFetchCredentials?: OpenApiSpecFetchCredentialsInput;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, OpenApiCredentialInput>;
  readonly queryParams?: Record<string, OpenApiCredentialInput>;
  readonly oauth2?: OpenApiOAuthInput;
  readonly credentialTargetScope?: string;
}

export interface OpenApiUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, OpenApiCredentialInput>;
  readonly queryParams?: Record<string, OpenApiCredentialInput>;
  readonly credentialTargetScope?: string;
  /** Refresh the source's stored OAuth2 metadata after a successful
   *  re-authenticate. */
  readonly oauth2?: OpenApiOAuthInput;
}

/**
 * Errors any OpenAPI extension method may surface. The first three are
 * plugin-domain tagged errors that flow directly to clients (4xx, each
 * carrying its own `HttpApiSchema` status). `StorageFailure` covers
 * raw backend failures (`StorageError`) plus `UniqueViolationError`;
 * the HTTP edge (`@executor-js/api`'s `withCapture`) translates
 * `StorageError` to the opaque `InternalError({ traceId })` at Layer
 * composition. `UniqueViolationError` passes through — plugins can
 * `Effect.catchTag` it if they want a friendlier user-facing error.
 */
export type OpenApiExtensionFailure =
  | OpenApiParseError
  | OpenApiExtractionError
  | OpenApiOAuthError
  | StorageFailure;

export interface OpenApiPluginExtension {
  readonly previewSpec: (
    input: string | OpenApiPreviewInput,
  ) => Effect.Effect<
    SpecPreview,
    OpenApiParseError | OpenApiExtractionError | OpenApiOAuthError | StorageFailure
  >;
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<
    { readonly sourceId: string; readonly toolCount: number },
    OpenApiParseError | OpenApiExtractionError | OpenApiOAuthError | StorageFailure
  >;
  readonly removeSpec: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly listSourceBindings: (
    sourceId: string,
    sourceScope: string,
  ) => Effect.Effect<readonly OpenApiSourceBindingRef[], StorageFailure>;
  readonly setSourceBinding: (
    input: OpenApiSourceBindingInput,
  ) => Effect.Effect<OpenApiSourceBindingRef, StorageFailure>;
  readonly removeSourceBinding: (
    sourceId: string,
    sourceScope: string,
    slot: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Control-tool input/output schemas
// ---------------------------------------------------------------------------

const PreviewSpecInputSchema = Schema.Struct({
  spec: Schema.String,
  specFetchCredentials: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Record(Schema.String, HeaderValueSchema)),
      queryParams: Schema.optional(Schema.Record(Schema.String, HeaderValueSchema)),
    }),
  ),
});
type PreviewSpecInput = typeof PreviewSpecInputSchema.Type;

const OpenApiHeaderInputSchema = Schema.Union([HeaderValueSchema, ConfiguredHeaderValueSchema]);
const OpenApiOAuthInputSchema = OAuth2SourceConfig;

const AddSourceInputSchema = Schema.Struct({
  scope: Schema.String,
  spec: Schema.String,
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiHeaderInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiCredentialInputSchema)),
  oauth2: Schema.optional(OpenApiOAuthInputSchema),
  credentialTargetScope: Schema.optional(Schema.String),
  specFetchCredentials: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Record(Schema.String, HeaderValueSchema)),
      queryParams: Schema.optional(Schema.Record(Schema.String, HeaderValueSchema)),
    }),
  ),
});
type AddSourceInput = typeof AddSourceInputSchema.Type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  new OperationBinding({
    method: def.operation.method,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
  });

const descriptionFor = (def: ToolDefinition): string => {
  const op = def.operation;
  return Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
};

const slotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const headerSlotFromName = (name: string): string => `header:${slotPart(name)}`;

const queryParamSlotFromName = (name: string): string => `query_param:${slotPart(name)}`;

const specFetchHeaderSlotFromName = (name: string): string => `spec_fetch_header:${slotPart(name)}`;

const specFetchQueryParamSlotFromName = (name: string): string =>
  `spec_fetch_query_param:${slotPart(name)}`;

const canonicalizeHeaders = (
  headers: Record<string, OpenApiCredentialInput> | undefined,
): {
  readonly headers: Record<string, ConfiguredHeaderValue>;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  const nextHeaders: Record<string, ConfiguredHeaderValue> = {};
  const bindings: Array<{
    slot: string;
    value: OpenApiSourceBindingValue;
    targetScope?: string;
  }> = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      nextHeaders[name] = value;
      continue;
    }
    if ("kind" in value) {
      nextHeaders[name] = value;
      continue;
    }
    const slot = headerSlotFromName(name);
    nextHeaders[name] = new ConfiguredHeaderBinding({
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
  return { headers: nextHeaders, bindings };
};

const canonicalizeCredentialMap = (
  values: Record<string, OpenApiCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredHeaderValue>;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  const nextValues: Record<string, ConfiguredHeaderValue> = {};
  const bindings: Array<{
    slot: string;
    value: OpenApiSourceBindingValue;
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
    nextValues[name] = new ConfiguredHeaderBinding({
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

const canonicalizeSpecFetchCredentials = (
  credentials:
    | {
        readonly headers?: Record<string, OpenApiCredentialInput>;
        readonly queryParams?: Record<string, OpenApiCredentialInput>;
      }
    | undefined,
): {
  readonly credentials?: SourceConfig["specFetchCredentials"];
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  const headers = canonicalizeCredentialMap(credentials?.headers, specFetchHeaderSlotFromName);
  const queryParams = canonicalizeCredentialMap(
    credentials?.queryParams,
    specFetchQueryParamSlotFromName,
  );
  const nextCredentials =
    Object.keys(headers.values).length === 0 && Object.keys(queryParams.values).length === 0
      ? undefined
      : {
          ...(Object.keys(headers.values).length > 0 ? { headers: headers.values } : {}),
          ...(Object.keys(queryParams.values).length > 0
            ? { queryParams: queryParams.values }
            : {}),
        };
  return {
    credentials: nextCredentials,
    bindings: [...headers.bindings, ...queryParams.bindings],
  };
};

const canonicalizeOAuth2 = (
  oauth2: OpenApiOAuthInput | undefined,
): {
  readonly oauth2?: OAuth2SourceConfig;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: OpenApiSourceBindingValue;
  }>;
} => {
  if (!oauth2) return { bindings: [] };
  return {
    oauth2,
    bindings: [],
  };
};

interface EffectiveSourceConfig {
  readonly config: SourceConfig;
  readonly headersSource: StoredSource;
  readonly queryParamsSource: StoredSource;
  readonly specFetchCredentialsSource: StoredSource;
  readonly oauth2Source: StoredSource;
}

const OPENAPI_PLUGIN_ID = "openapi";

const scopeRanks = (ctx: PluginCtx<OpenapiStore>): ReadonlyMap<string, number> =>
  new Map(ctx.scopes.map((scope, index) => [String(scope.id), index]));

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: string): number =>
  ranks.get(scopeId) ?? Infinity;

const coreBindingToOpenApiBinding = (binding: CredentialBindingRef): OpenApiSourceBindingRef =>
  new OpenApiSourceBindingRef({
    sourceId: binding.sourceId,
    sourceScopeId: binding.sourceScopeId,
    scopeId: binding.scopeId,
    slot: binding.slotKey,
    value: binding.value,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });

const listOpenApiSourceBindings = (
  ctx: PluginCtx<OpenapiStore>,
  sourceId: string,
  sourceScope: string,
): Effect.Effect<readonly OpenApiSourceBindingRef[], StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return [];
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: OPENAPI_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    return bindings
      .filter((binding) => scopeRank(ranks, binding.scopeId) <= sourceSourceRank)
      .map(coreBindingToOpenApiBinding);
  });

const resolveOpenApiSourceBinding = (
  ctx: PluginCtx<OpenapiStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<OpenApiSourceBindingRef | null, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return null;
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: OPENAPI_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    const binding = bindings
      .filter(
        (candidate) =>
          candidate.slotKey === slot && scopeRank(ranks, candidate.scopeId) <= sourceSourceRank,
      )
      .sort((a, b) => scopeRank(ranks, a.scopeId) - scopeRank(ranks, b.scopeId))[0];
    return binding ? coreBindingToOpenApiBinding(binding) : null;
  });

const validateOpenApiBindingTarget = (
  ctx: PluginCtx<OpenapiStore>,
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
          `OpenAPI source binding references source scope "${input.sourceScope}" ` +
          `which is not in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank === Infinity) {
      return yield* new StorageError({
        message:
          `OpenAPI source binding targets scope "${input.targetScope}" which is not ` +
          `in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank > sourceSourceRank) {
      return yield* new StorageError({
        message:
          `OpenAPI source bindings for "${input.sourceId}" cannot be written at ` +
          `outer scope "${input.targetScope}" because the base source lives at ` +
          `"${input.sourceScope}"`,
        cause: undefined,
      });
    }
  });

const targetScopeForBinding = (
  fallbackTargetScope: string | undefined,
  binding: { readonly slot: string; readonly targetScope?: string },
): Effect.Effect<string, OpenApiOAuthError> => {
  const targetScope = binding.targetScope ?? fallbackTargetScope;
  if (targetScope) return Effect.succeed(targetScope);
  return Effect.fail(
    new OpenApiOAuthError({
      message: "credentialTargetScope is required when adding direct OpenAPI credentials",
    }),
  );
};

const findOuterSource = (
  ctx: PluginCtx<OpenapiStore>,
  namespace: string,
  scope: string,
): Effect.Effect<StoredSource | null, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const baseRank = scopeRank(ranks, scope);
    for (let index = baseRank + 1; index < ctx.scopes.length; index++) {
      const candidateScope = ctx.scopes[index];
      if (!candidateScope) continue;
      const source = yield* ctx.storage.getSource(namespace, candidateScope.id);
      if (source) return source;
    }
    return null;
  });

const resolveEffectiveSourceConfig = (
  ctx: PluginCtx<OpenapiStore>,
  base: StoredSource,
): Effect.Effect<EffectiveSourceConfig, StorageFailure> =>
  Effect.gen(function* () {
    const fallback = yield* findOuterSource(ctx, base.namespace, base.scope);

    if (!fallback) {
      return {
        config: base.config,
        headersSource: base,
        queryParamsSource: base,
        specFetchCredentialsSource: base,
        oauth2Source: base,
      };
    }

    const hasBaseHeaders = Object.keys(base.config.headers ?? {}).length > 0;
    const hasBaseQueryParams = Object.keys(base.config.queryParams ?? {}).length > 0;
    const hasBaseSpecFetchCredentials = base.config.specFetchCredentials !== undefined;
    return {
      config: {
        ...base.config,
        sourceUrl: base.config.sourceUrl ?? fallback.config.sourceUrl,
        baseUrl: fallback.config.baseUrl,
        namespace: base.config.namespace ?? fallback.config.namespace,
        headers: hasBaseHeaders ? base.config.headers : fallback.config.headers,
        queryParams: hasBaseQueryParams ? base.config.queryParams : fallback.config.queryParams,
        specFetchCredentials:
          base.config.specFetchCredentials ?? fallback.config.specFetchCredentials,
        oauth2: base.config.oauth2 ?? fallback.config.oauth2,
      },
      headersSource: hasBaseHeaders ? base : fallback,
      queryParamsSource: hasBaseQueryParams ? base : fallback,
      specFetchCredentialsSource: hasBaseSpecFetchCredentials ? base : fallback,
      oauth2Source: base.config.oauth2 ? base : fallback,
    };
  });

const resolveConfiguredValueMap = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly values: Record<string, ConfiguredHeaderValue>;
    readonly missingLabel: string;
  },
): Effect.Effect<Record<string, string>, OpenApiOAuthError | StorageFailure> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = yield* resolveOpenApiSourceBinding(
        ctx,
        params.sourceId,
        params.sourceScope,
        value.slot,
      );
      if (binding?.value.kind === "secret") {
        const secret = yield* ctx.secrets
          .getAtScope(binding.value.secretId, binding.value.secretScopeId ?? binding.scopeId)
          .pipe(
            Effect.catchTag("SecretOwnedByConnectionError", () =>
              Effect.fail(
                new OpenApiOAuthError({
                  message: `Secret not found for header "${name}"`,
                }),
              ),
            ),
          );
        if (secret === null) {
          return yield* new OpenApiOAuthError({
            message: `Missing secret "${binding.value.secretId}" for ${params.missingLabel} "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      return yield* new OpenApiOAuthError({
        message: `Missing binding for ${params.missingLabel} "${name}"`,
      });
    }
    return resolved;
  });

const resolveConfiguredHeaders = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly headers: Record<string, ConfiguredHeaderValue>;
  },
): Effect.Effect<Record<string, string>, OpenApiOAuthError | StorageFailure> =>
  resolveConfiguredValueMap(ctx, {
    sourceId: params.sourceId,
    sourceScope: params.sourceScope,
    values: params.headers,
    missingLabel: "header",
  });

const resolveSecretBackedValues = (
  ctx: PluginCtx<OpenapiStore>,
  values: Record<string, HeaderValue> | undefined,
): Effect.Effect<Record<string, string>, OpenApiOAuthError | StorageFailure> =>
  resolveSecretBackedMap({
    values,
    getSecret: ctx.secrets.get,
    onMissing: (name) =>
      new OpenApiOAuthError({
        message: `Secret not found for "${name}"`,
      }),
    onError: (err, name) =>
      Predicate.isTagged("SecretOwnedByConnectionError")(err)
        ? new OpenApiOAuthError({
            message: `Secret not found for "${name}"`,
          })
        : err,
  }).pipe(
    Effect.mapError((err) =>
      Predicate.isTagged("SecretOwnedByConnectionError")(err)
        ? new OpenApiOAuthError({ message: "Secret resolution failed" })
        : err,
    ),
    Effect.map((resolved) => resolved ?? {}),
  );

const resolveOAuthConnectionId = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly oauth2: OAuth2SourceConfig;
  },
): Effect.Effect<
  { readonly connectionId: string; readonly scopeId: string } | null,
  StorageFailure
> =>
  Effect.gen(function* () {
    const binding = yield* resolveOpenApiSourceBinding(
      ctx,
      params.sourceId,
      params.sourceScope,
      params.oauth2.connectionSlot,
    );
    if (binding?.value.kind === "connection") {
      const connectionId = binding.value.connectionId;
      const connection = yield* ctx.connections.getAtScope(connectionId, binding.scopeId);
      return connection ? { connectionId, scopeId: binding.scopeId } : null;
    }
    return null;
  });

const resolveSpecFetchInputCredentials = (
  ctx: PluginCtx<OpenapiStore>,
  credentials: OpenApiSpecFetchCredentialsInput | undefined,
) =>
  Effect.gen(function* () {
    if (!credentials) return undefined;
    return {
      headers: yield* resolveSecretBackedValues(ctx, credentials.headers),
      queryParams: yield* resolveSecretBackedValues(ctx, credentials.queryParams),
    };
  });

const resolveStoredSpecFetchCredentials = (
  ctx: PluginCtx<OpenapiStore>,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly credentials: SourceConfig["specFetchCredentials"] | undefined;
  },
) =>
  Effect.gen(function* () {
    if (!params.credentials) return undefined;
    return {
      headers: yield* resolveConfiguredValueMap(ctx, {
        sourceId: params.sourceId,
        sourceScope: params.sourceScope,
        values: params.credentials.headers ?? {},
        missingLabel: "spec fetch header",
      }),
      queryParams: yield* resolveConfiguredValueMap(ctx, {
        sourceId: params.sourceId,
        sourceScope: params.sourceScope,
        values: params.credentials.queryParams ?? {},
        missingLabel: "spec fetch query parameter",
      }),
    };
  });

// ---------------------------------------------------------------------------
// OAuth2 token exchange / refresh is owned by `ctx.oauth`, which registers
// the canonical core `"oauth2"` ConnectionProvider. OpenAPI owns only the
// source-specific semantics: slots for client credentials and the connection
// binding that invocation resolves before calling `ctx.connections.accessToken`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OpenApiPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const toOpenApiSourceConfig = (
  namespace: string,
  config: OpenApiSpecConfig,
): OpenApiSourceConfig => {
  const configHeaders: Record<string, HeaderValueValue> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value === "string" || !("kind" in value)) {
      configHeaders[name] = value;
    }
  }
  return {
    kind: "openapi",
    spec: config.spec,
    baseUrl: config.baseUrl,
    namespace,
    headers: headersToConfigValues(
      Object.keys(configHeaders).length > 0 ? configHeaders : undefined,
    ),
  };
};

const isHttpUrl = (s: string): boolean => s.startsWith("http://") || s.startsWith("https://");

export const openApiPlugin = definePlugin((options?: OpenApiPluginOptions) => {
  type RebuildInput = {
    readonly specText: string;
    readonly scope: string;
    readonly sourceUrl?: string;
    readonly name?: string;
    readonly baseUrl?: string;
    readonly namespace?: string;
    readonly headers?: Record<string, OpenApiHeaderInput>;
    readonly queryParams?: Record<string, OpenApiCredentialInput>;
    readonly specFetchCredentials?: {
      readonly headers?: Record<string, OpenApiCredentialInput>;
      readonly queryParams?: Record<string, OpenApiCredentialInput>;
    };
    readonly oauth2?: OpenApiOAuthInput;
    readonly credentialTargetScope?: string;
  };

  // ctx comes from the plugin runtime — the same instance is passed to
  // `extension(ctx)` and to every lifecycle hook (`refreshSource`, etc.),
  // so helpers parameterised on ctx can be called from either surface.
  const rebuildSource = (ctx: PluginCtx<OpenapiStore>, input: RebuildInput) =>
    Effect.gen(function* () {
      const doc = yield* parse(input.specText);
      const result = yield* extract(doc);

      const namespace =
        input.namespace ??
        Option.getOrElse(result.title, () => "api")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_");
      const outerSource = yield* findOuterSource(ctx, namespace, input.scope);
      if (outerSource && input.baseUrl !== undefined && input.baseUrl.trim() !== "") {
        return yield* new OpenApiOAuthError({
          message: "OpenAPI source shadows inherit the outer source base URL",
        });
      }

      const hoistedDefs: Record<string, unknown> = {};
      if (doc.components?.schemas) {
        for (const [k, v] of Object.entries(doc.components.schemas)) {
          hoistedDefs[k] = normalizeOpenApiRefs(v);
        }
      }

      const baseUrl = outerSource ? undefined : (input.baseUrl ?? resolveBaseUrl(result.servers));
      const canonicalHeaders = canonicalizeHeaders(input.headers);
      const canonicalQueryParams = canonicalizeCredentialMap(
        input.queryParams,
        queryParamSlotFromName,
      );
      const canonicalSpecFetchCredentials = canonicalizeSpecFetchCredentials(
        input.specFetchCredentials,
      );
      const canonicalOAuth2 = canonicalizeOAuth2(input.oauth2);
      const directBindings = [
        ...canonicalHeaders.bindings,
        ...canonicalQueryParams.bindings,
        ...canonicalSpecFetchCredentials.bindings,
        ...canonicalOAuth2.bindings,
      ];
      for (const binding of directBindings) {
        const bindingTargetScope = yield* targetScopeForBinding(
          input.credentialTargetScope,
          binding,
        );
        yield* validateOpenApiBindingTarget(ctx, {
          sourceId: namespace,
          sourceScope: input.scope,
          targetScope: bindingTargetScope,
        });
      }
      const definitions = compileToolDefinitions(result.operations);
      const sourceName = input.name ?? Option.getOrElse(result.title, () => namespace);

      const sourceConfig: SourceConfig = {
        spec: input.specText,
        sourceUrl: input.sourceUrl,
        baseUrl,
        namespace: input.namespace,
        headers: canonicalHeaders.headers,
        queryParams: canonicalQueryParams.values,
        specFetchCredentials: canonicalSpecFetchCredentials.credentials,
        oauth2: canonicalOAuth2.oauth2,
      };

      const storedSource: StoredSource = {
        namespace,
        scope: input.scope,
        name: sourceName,
        config: sourceConfig,
      };

      const storedOps: StoredOperation[] = definitions.map((def) => ({
        toolId: `${namespace}.${def.toolPath}`,
        sourceId: namespace,
        binding: toBinding(def),
      }));

      yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.storage.upsertSource(storedSource, storedOps);
          yield* ctx.core.sources.register({
            id: namespace,
            scope: input.scope,
            kind: "openapi",
            name: sourceName,
            url: baseUrl || undefined,
            canRemove: true,
            // `canRefresh` reflects whether we still know the
            // origin URL — sources added from raw spec text have
            // nothing to re-fetch, so refresh stays disabled.
            canRefresh: input.sourceUrl != null,
            canEdit: true,
            tools: definitions.map((def) => ({
              name: def.toolPath,
              description: descriptionFor(def),
              inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(def.operation.inputSchema)),
              outputSchema: normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
            })),
          });

          if (directBindings.length > 0) {
            for (const binding of directBindings) {
              const bindingTargetScope = yield* targetScopeForBinding(
                input.credentialTargetScope,
                binding,
              );
              yield* ctx.credentialBindings.set({
                targetScope: ScopeId.make(bindingTargetScope),
                pluginId: OPENAPI_PLUGIN_ID,
                sourceId: namespace,
                sourceScope: ScopeId.make(input.scope),
                slotKey: binding.slot,
                value: binding.value,
              });
            }
          }

          if (Object.keys(hoistedDefs).length > 0) {
            yield* ctx.core.definitions.register({
              sourceId: namespace,
              scope: input.scope,
              definitions: hoistedDefs,
            });
          }
        }),
      );

      return { sourceId: namespace, toolCount: definitions.length };
    });

  // No-op for missing sources and for sources added from raw spec
  // text (no URL to re-fetch from). UIs gate the action via
  // `canRefresh` on the source row; reaching here without a URL
  // means the caller bypassed that gate, so we stay quiet rather
  // than surface a 500 through the unwhitelisted error channel.
  const refreshSourceInternal = (ctx: PluginCtx<OpenapiStore>, sourceId: string, scope: string) =>
    Effect.gen(function* () {
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
      const existing = yield* ctx.storage.getSource(sourceId, scope);
      if (!existing) return;
      const effective = yield* resolveEffectiveSourceConfig(ctx, existing);
      const resolvedConfig = effective.config;
      const sourceUrl = resolvedConfig.sourceUrl;
      if (!sourceUrl) return;
      const credentials = yield* resolveStoredSpecFetchCredentials(ctx, {
        sourceId: existing.namespace,
        sourceScope: effective.specFetchCredentialsSource.scope,
        credentials: resolvedConfig.specFetchCredentials,
      });
      const specText = yield* resolveSpecText(sourceUrl, credentials).pipe(
        Effect.provide(httpClientLayer),
      );
      yield* rebuildSource(ctx, {
        specText,
        scope,
        sourceUrl,
        name: existing.name,
        baseUrl: resolvedConfig.baseUrl,
        namespace: existing.namespace,
        headers: existing.config.headers,
        queryParams: existing.config.queryParams,
        specFetchCredentials: existing.config.specFetchCredentials,
        oauth2: existing.config.oauth2,
        credentialTargetScope: scope,
      });
    });

  return {
    id: "openapi" as const,
    packageName: "@executor-js/plugin-openapi",
    schema: openapiSchema,
    storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

    extension: (ctx) => {
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
      const addSpecInternal = (config: OpenApiSpecConfig) =>
        Effect.gen(function* () {
          // Resolve URL → text and parse BEFORE opening a transaction.
          // Holding `BEGIN` on the pool=1 Postgres connection across a
          // network fetch is the Hyperdrive deadlock path in production.
          const credentials = yield* resolveSpecFetchInputCredentials(
            ctx,
            config.specFetchCredentials,
          );
          const specText = yield* resolveSpecText(config.spec, credentials).pipe(
            Effect.provide(httpClientLayer),
          );
          return yield* rebuildSource(ctx, {
            specText,
            scope: config.scope,
            sourceUrl: isHttpUrl(config.spec) ? config.spec : undefined,
            name: config.name,
            baseUrl: config.baseUrl,
            namespace: config.namespace,
            headers: config.headers,
            queryParams: config.queryParams,
            specFetchCredentials: config.specFetchCredentials,
            oauth2: config.oauth2,
            // Default to the source's own scope. refreshSource and editSource
            // do the same; without this, config-sync's addSpec — which never
            // passes the field — fails with "credentialTargetScope is
            // required" the moment the jsonc declares any header secret.
            credentialTargetScope: config.credentialTargetScope ?? config.scope,
          });
        });

      const configFile = options?.configFile;

      return {
        previewSpec: (input: string | OpenApiPreviewInput) =>
          Effect.gen(function* () {
            const previewInput = typeof input === "string" ? { spec: input } : input;
            const credentials = yield* resolveSpecFetchInputCredentials(
              ctx,
              previewInput.specFetchCredentials,
            );
            const specText = yield* resolveSpecText(previewInput.spec, credentials).pipe(
              Effect.provide(httpClientLayer),
            );
            return yield* previewSpec(specText).pipe(Effect.provide(httpClientLayer));
          }),

        addSpec: (config: OpenApiSpecConfig) =>
          Effect.gen(function* () {
            const result = yield* addSpecInternal(config);
            if (configFile) {
              yield* configFile.upsertSource(toOpenApiSourceConfig(result.sourceId, config));
            }
            return result;
          }),

        removeSpec: (namespace: string, scope: string) =>
          Effect.gen(function* () {
            yield* ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.credentialBindings.removeForSource({
                  pluginId: OPENAPI_PLUGIN_ID,
                  sourceId: namespace,
                  sourceScope: ScopeId.make(scope),
                });
                yield* ctx.storage.removeSource(namespace, scope);
                yield* ctx.core.sources.unregister({
                  id: namespace,
                  targetScope: scope,
                });
              }),
            );
            if (configFile) {
              yield* configFile.removeSource(namespace);
            }
          }),

        getSource: (namespace: string, scope: string) =>
          Effect.gen(function* () {
            const source = yield* ctx.storage.getSource(namespace, scope);
            if (!source) return null;
            const effective = yield* resolveEffectiveSourceConfig(ctx, source);
            return {
              ...source,
              config: effective.config,
            };
          }),

        updateSource: (namespace: string, scope: string, input: OpenApiUpdateSourceInput) =>
          Effect.gen(function* () {
            const existing = yield* ctx.storage.getSource(namespace, scope);
            if (!existing) return;
            const canonicalHeaders =
              input.headers !== undefined ? canonicalizeHeaders(input.headers) : null;
            const canonicalOAuth2 =
              input.oauth2 !== undefined ? canonicalizeOAuth2(input.oauth2) : null;
            const canonicalQueryParams =
              input.queryParams !== undefined
                ? canonicalizeCredentialMap(input.queryParams, queryParamSlotFromName)
                : null;
            const directBindings = [
              ...(canonicalHeaders?.bindings ?? []),
              ...(canonicalQueryParams?.bindings ?? []),
              ...(canonicalOAuth2?.bindings ?? []),
            ];
            const affectedPrefixes = [
              ...(input.headers !== undefined ? ["header:"] : []),
              ...(input.queryParams !== undefined ? ["query_param:"] : []),
              ...(input.oauth2 !== undefined ? ["oauth2:"] : []),
            ];
            const targetScope = input.credentialTargetScope ?? scope;
            if (input.baseUrl !== undefined && input.baseUrl.trim() !== "") {
              const outerSource = yield* findOuterSource(ctx, namespace, scope);
              if (outerSource) {
                return yield* new OpenApiOAuthError({
                  message: "OpenAPI source shadows inherit the outer source base URL",
                });
              }
            }
            if (affectedPrefixes.length > 0 || directBindings.length > 0) {
              yield* validateOpenApiBindingTarget(ctx, {
                sourceId: namespace,
                sourceScope: scope,
                targetScope,
              });
            }
            yield* ctx.transaction(
              Effect.gen(function* () {
                yield* ctx.storage.updateSourceMeta(namespace, scope, {
                  name: input.name?.trim() || undefined,
                  baseUrl: input.baseUrl,
                  headers: canonicalHeaders?.headers,
                  queryParams: canonicalQueryParams?.values,
                  oauth2: canonicalOAuth2?.oauth2,
                });
                if (affectedPrefixes.length > 0 || directBindings.length > 0) {
                  yield* ctx.credentialBindings.replaceForSource({
                    targetScope: ScopeId.make(targetScope),
                    pluginId: OPENAPI_PLUGIN_ID,
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
          listOpenApiSourceBindings(ctx, sourceId, sourceScope),

        setSourceBinding: (input: OpenApiSourceBindingInput) =>
          Effect.gen(function* () {
            yield* validateOpenApiBindingTarget(ctx, {
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              targetScope: input.scope,
            });
            const binding = yield* ctx.credentialBindings.set({
              targetScope: input.scope,
              pluginId: OPENAPI_PLUGIN_ID,
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              slotKey: input.slot,
              value: input.value,
            });
            return coreBindingToOpenApiBinding(binding);
          }),

        removeSourceBinding: (sourceId: string, sourceScope: string, slot: string, scope: string) =>
          Effect.gen(function* () {
            yield* validateOpenApiBindingTarget(ctx, {
              sourceId,
              sourceScope,
              targetScope: scope,
            });
            yield* ctx.credentialBindings.remove({
              targetScope: ScopeId.make(scope),
              pluginId: OPENAPI_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(sourceScope),
              slotKey: slot,
            });
          }),
      };
    },

    staticSources: (self) => [
      {
        id: "openapi",
        kind: "control",
        name: "OpenAPI",
        tools: [
          {
            name: "previewSpec",
            description: "Preview an OpenAPI document before adding it as a source",
            inputSchema: {
              type: "object",
              properties: {
                spec: { type: "string" },
                specFetchCredentials: { type: "object" },
              },
              required: ["spec"],
            },
            handler: ({ args }) => self.previewSpec(args as PreviewSpecInput),
          },
          {
            name: "addSource",
            description: "Add an OpenAPI source and register its operations as tools",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add an OpenAPI source",
            },
            inputSchema: {
              type: "object",
              properties: {
                scope: { type: "string" },
                spec: { type: "string" },
                name: { type: "string" },
                baseUrl: { type: "string" },
                namespace: { type: "string" },
                headers: { type: "object" },
                queryParams: { type: "object" },
                oauth2: { type: "object" },
                credentialTargetScope: { type: "string" },
                specFetchCredentials: { type: "object" },
              },
              required: ["scope", "spec"],
            },
            outputSchema: {
              type: "object",
              properties: {
                sourceId: { type: "string" },
                toolCount: { type: "number" },
              },
              required: ["sourceId", "toolCount"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input: AddSourceInput =
                  yield* Schema.decodeUnknownEffect(AddSourceInputSchema)(args);
                return yield* self.addSpec(input);
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
        // openapi_operation + openapi_source rows live at the same
        // scope, so pin every store lookup to it instead of relying
        // on the scoped adapter's stack-wide fall-through.
        const toolScope = toolRow.scope_id;
        const op = yield* ctx.storage.getOperationByToolId(toolRow.id, toolScope);
        if (!op) {
          return yield* new OpenApiExtractionError({
            message: `No OpenAPI operation found for tool "${toolRow.id}"`,
          });
        }
        const source = yield* ctx.storage.getSource(op.sourceId, toolScope);
        if (!source) {
          return yield* new OpenApiExtractionError({
            message: `No OpenAPI source found for "${op.sourceId}"`,
          });
        }

        const effective = yield* resolveEffectiveSourceConfig(ctx, source);
        const config = effective.config;
        const resolvedHeaders = yield* resolveConfiguredHeaders(ctx, {
          sourceId: op.sourceId,
          sourceScope: effective.headersSource.scope,
          headers: config.headers ?? {},
        });
        const resolvedQueryParams = yield* resolveConfiguredValueMap(ctx, {
          sourceId: op.sourceId,
          sourceScope: effective.queryParamsSource.scope,
          values: config.queryParams ?? {},
          missingLabel: "query parameter",
        });

        // If the source has OAuth2 auth, resolve a guaranteed-fresh
        // access token from the backing Connection and inject the
        // Authorization header (wins over a manually-set one). All the
        // refresh complexity lives in the SDK — the plugin just asks.
        if (config.oauth2) {
          const connection = yield* resolveOAuthConnectionId(ctx, {
            sourceId: op.sourceId,
            sourceScope: effective.oauth2Source.scope,
            oauth2: config.oauth2,
          });
          if (!connection) {
            return yield* new OpenApiOAuthError({
              message: `OAuth configuration for "${op.sourceId}" is missing a connection binding`,
            });
          }
          const accessToken = yield* ctx.connections
            .accessTokenAtScope(connection.connectionId, connection.scopeId)
            .pipe(
              Effect.mapError(
                () =>
                  new OpenApiOAuthError({
                    message: "OAuth connection resolution failed",
                  }),
              ),
            );
          resolvedHeaders.authorization = `Bearer ${accessToken}`;
        }

        const result = yield* invokeWithLayer(
          op.binding,
          (args ?? {}) as Record<string, unknown>,
          config.baseUrl ?? "",
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
        // org-level openapi source plus a per-user override that
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
          if (binding) {
            out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
          }
        }
        return out;
      }),

    removeSource: ({ ctx, sourceId, scope }) =>
      Effect.gen(function* () {
        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.credentialBindings.removeForSource({
              pluginId: OPENAPI_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(scope),
            });
            yield* ctx.storage.removeSource(sourceId, scope);
          }),
        );
      }),

    // OpenAPI credential usages are reported by the core `credential_binding`
    // table. Source storage carries only source-owned slot structure.
    usagesForSecret: () => Effect.succeed([]),

    usagesForConnection: () => Effect.succeed([]),

    // Re-fetch the spec from its origin URL (captured at addSpec time)
    // and replay the same parse → extract → upsertSource → register
    // path used by addSpec. Sources without a stored URL surface a
    // typed `OpenApiParseError` — the executor only dispatches refresh
    // when `canRefresh: true`, so a raw-text source reaching here
    // means stale UI state, which is worth surfacing to the caller.
    refreshSource: ({ ctx, sourceId, scope }) => refreshSourceInternal(ctx, sourceId, scope),

    detect: ({ ctx, url }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed) return null;
        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (error) => error,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return null;
        const specText = yield* resolveSpecText(trimmed).pipe(
          Effect.provide(httpClientLayer),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (specText === null) return null;
        const doc = yield* parse(specText).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!doc) return null;
        const result = yield* extract(doc).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!result) return null;
        const namespace = Option.getOrElse(result.title, () => "api")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_");
        const name = Option.getOrElse(result.title, () => namespace);
        return new SourceDetectionResult({
          kind: "openapi",
          confidence: "high",
          endpoint: trimmed,
          name,
          namespace,
        });
      }),

    // HTTP transport. `OpenApiHandlers` is the existing late-binding
    // Layer that requires `OpenApiExtensionService`; the host satisfies
    // it via the spec's `extensionService` Tag — at boot for local
    // (`composePluginHandlers(plugins, executor)`), per-request for
    // cloud (`providePluginExtensions(plugins)(executor)`).
    routes: () => OpenApiGroup,
    handlers: () => OpenApiHandlers,
    extensionService: OpenApiExtensionService,
  };
});
