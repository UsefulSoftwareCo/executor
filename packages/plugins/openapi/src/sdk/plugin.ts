import { Effect, Option, Predicate, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  ConnectionId,
  CredentialBindingRef,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  StorageError,
  ToolResult,
  authToolFailure,
  defaultSourceInstallScopeId,
  definePlugin,
  tool,
  resolveSecretBackedMap,
  type CredentialBindingValue,
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

import {
  OpenApiAuthRequiredError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  OpenApiParseError,
} from "./errors";
import { parse, resolveSpecText } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { annotationsForOperation, invokeWithLayer } from "./invoke";
import { previewSpec, type SpecPreview } from "./preview";
import { openApiPresets } from "./presets";
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
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OperationBinding,
  type ConfiguredHeaderValue as ConfiguredHeaderValueValue,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

const STRINGIFIED_BODY_CAP = 1024;
const UpstreamMessageBody = Schema.Struct({ message: Schema.String });
const UpstreamErrorMessageBody = Schema.Struct({ errorMessage: Schema.String });
const UpstreamNestedErrorBody = Schema.Struct({ error: UpstreamMessageBody });
const UpstreamErrorsArrayBody = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      detail: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});
const UpstreamDescriptionBody = Schema.Struct({
  detail: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const decodeUpstreamMessageBody = Schema.decodeUnknownOption(UpstreamMessageBody);
const decodeUpstreamErrorMessageBody = Schema.decodeUnknownOption(UpstreamErrorMessageBody);
const decodeUpstreamNestedErrorBody = Schema.decodeUnknownOption(UpstreamNestedErrorBody);
const decodeUpstreamErrorsArrayBody = Schema.decodeUnknownOption(UpstreamErrorsArrayBody);
const decodeUpstreamDescriptionBody = Schema.decodeUnknownOption(UpstreamDescriptionBody);

const clampedStringify = (value: unknown): string => {
  let s: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.stringify may throw on cycles; fall back to String() so the upstream body can still be surfaced as ToolError.details fallback text
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > STRINGIFIED_BODY_CAP ? `${s.slice(0, STRINGIFIED_BODY_CAP)}…` : s;
};

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.length > 0);

// Walk known upstream error-body shapes so ToolError.message stays concise
// while ToolError.details preserves the original body.
const extractUpstreamMessage = (body: unknown, status: number): string => {
  if (typeof body === "string") {
    return body.length > 0 ? body : `Upstream returned HTTP ${status}`;
  }
  const nested = Option.getOrUndefined(decodeUpstreamNestedErrorBody(body));
  const messageBody = Option.getOrUndefined(decodeUpstreamMessageBody(body));
  const errorMessageBody = Option.getOrUndefined(decodeUpstreamErrorMessageBody(body));
  const errorsBody = Option.getOrUndefined(decodeUpstreamErrorsArrayBody(body));
  const descriptionBody = Option.getOrUndefined(decodeUpstreamDescriptionBody(body));
  const arrayMessage = errorsBody?.errors
    .map(({ detail, message: upstreamMessage, title }) =>
      firstNonEmpty(detail, upstreamMessage, title),
    )
    .find((message) => message !== undefined);
  const message = firstNonEmpty(
    nested?.error.message,
    messageBody?.message,
    errorMessageBody?.errorMessage,
    arrayMessage,
    descriptionBody?.detail,
    descriptionBody?.title,
    descriptionBody?.description,
  );
  if (message !== undefined) return message;
  if (body !== null && typeof body === "object") {
    return clampedStringify(body);
  }
  return `Upstream returned HTTP ${status}`;
};

export type HeaderValue = HeaderValueValue;
export type ConfiguredHeaderValue = ConfiguredHeaderValueValue;
export type OpenApiOAuthInput = OAuth2SourceConfig;

export type OpenApiSpecInput = typeof OpenApiSpecInputSchema.Type;

export type OpenApiSecretShapeInput = typeof OpenApiSecretShapeInputSchema.Type;

export type OpenApiConfiguredValueInput =
  | string
  | OpenApiSecretShapeInput
  | ConfiguredHeaderValueValue;

export interface OpenApiSpecFetchCredentialsInput {
  readonly headers?: Record<string, OpenApiConfiguredValueInput>;
  readonly queryParams?: Record<string, OpenApiConfiguredValueInput>;
}

export interface OpenApiPreviewSpecFetchCredentialsInput {
  readonly headers?: Record<string, HeaderValue>;
  readonly queryParams?: Record<string, HeaderValue>;
}

export interface OpenApiPreviewInput {
  readonly spec: string;
  readonly specFetchCredentials?: OpenApiPreviewSpecFetchCredentialsInput;
}

export interface OpenApiSpecConfig {
  readonly spec: OpenApiSpecInput;
  readonly specFetchCredentials?: OpenApiSpecFetchCredentialsInput;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly namespace: string;
  readonly headers?: Record<string, OpenApiConfiguredValueInput>;
  readonly queryParams?: Record<string, OpenApiConfiguredValueInput>;
  readonly oauth2?: OpenApiOAuthInput;
}

export interface OpenApiSourceRef {
  readonly id: string;
  readonly scope: string;
}

export type OpenApiConfigureCredentialInput =
  | string
  | {
      readonly kind: "text";
      readonly text: string;
      readonly prefix?: string;
    }
  | {
      readonly kind: "secret";
      readonly secretId: string;
      readonly secretScope?: string;
      readonly prefix?: string;
    }
  | {
      readonly kind: "connection";
      readonly connectionId: string;
    };

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
  readonly configure: (
    source: OpenApiSourceRef,
    input: OpenApiConfigureInput,
  ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
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

const StaticPreviewServerVariableSchema = Schema.Struct({
  default: Schema.String,
  enum: Schema.NullOr(Schema.Array(Schema.String)),
  description: Schema.NullOr(Schema.String),
});
const StaticPreviewServerSchema = Schema.Struct({
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  variables: Schema.NullOr(Schema.Record(Schema.String, StaticPreviewServerVariableSchema)),
});
const StaticPreviewOAuthAuthorizationCodeFlowSchema = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  refreshUrl: Schema.NullOr(Schema.String),
  scopes: Schema.Record(Schema.String, Schema.String),
});
const StaticPreviewOAuthClientCredentialsFlowSchema = Schema.Struct({
  tokenUrl: Schema.String,
  refreshUrl: Schema.NullOr(Schema.String),
  scopes: Schema.Record(Schema.String, Schema.String),
});
const StaticPreviewOAuthFlowsSchema = Schema.Struct({
  authorizationCode: Schema.NullOr(StaticPreviewOAuthAuthorizationCodeFlowSchema),
  clientCredentials: Schema.NullOr(StaticPreviewOAuthClientCredentialsFlowSchema),
});
const StaticPreviewSecuritySchemeSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]),
  scheme: Schema.NullOr(Schema.String),
  bearerFormat: Schema.NullOr(Schema.String),
  in: Schema.NullOr(Schema.Literals(["header", "query", "cookie"])),
  headerName: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  flows: Schema.NullOr(StaticPreviewOAuthFlowsSchema),
  openIdConnectUrl: Schema.NullOr(Schema.String),
});
const StaticPreviewOAuth2PresetSchema = Schema.Struct({
  label: Schema.String,
  securitySchemeName: Schema.String,
  flow: Schema.Literals(["authorizationCode", "clientCredentials"]),
  authorizationUrl: Schema.NullOr(Schema.String),
  tokenUrl: Schema.String,
  refreshUrl: Schema.NullOr(Schema.String),
  scopes: Schema.Record(Schema.String, Schema.String),
});
const StaticPreviewSpecOutputSchema = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  servers: Schema.Array(StaticPreviewServerSchema),
  operationCount: Schema.Number,
  tags: Schema.Array(Schema.String),
  securitySchemes: Schema.Array(StaticPreviewSecuritySchemeSchema),
  authStrategies: Schema.Array(Schema.Struct({ schemes: Schema.Array(Schema.String) })),
  headerPresets: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      headers: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
      secretHeaders: Schema.Array(Schema.String),
    }),
  ),
  oauth2Presets: Schema.Array(StaticPreviewOAuth2PresetSchema),
});
type StaticPreviewSpecOutput = typeof StaticPreviewSpecOutputSchema.Type;

const OpenApiSpecInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("blob"), value: Schema.String }),
]);
const OpenApiSecretShapeInputSchema = Schema.Struct({
  kind: Schema.Literal("secret"),
  prefix: Schema.optional(Schema.String),
});
const OpenApiConfiguredValueInputSchema = Schema.Union([
  Schema.String,
  OpenApiSecretShapeInputSchema,
]);
const OpenApiConfigureCredentialInputSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: Schema.String,
    secretScope: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: Schema.String,
  }),
]);
const OpenApiConfigureInputSchema = Schema.Struct({
  scope: Schema.String,
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfigureCredentialInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfigureCredentialInputSchema)),
  specFetchCredentials: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfigureCredentialInputSchema)),
      queryParams: Schema.optional(
        Schema.Record(Schema.String, OpenApiConfigureCredentialInputSchema),
      ),
    }),
  ),
  oauth2: Schema.optional(
    Schema.Struct({
      clientId: Schema.optional(OpenApiConfigureCredentialInputSchema),
      clientSecret: Schema.optional(OpenApiConfigureCredentialInputSchema),
      connection: Schema.optional(OpenApiConfigureCredentialInputSchema),
    }),
  ),
  oauth2Source: Schema.optional(OAuth2SourceConfig),
});
export type OpenApiConfigureInput = typeof OpenApiConfigureInputSchema.Type;
const OpenApiConfigureSourceInputSchema = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  ...OpenApiConfigureInputSchema.fields,
});
const OpenApiOAuthInputSchema = OAuth2SourceConfig;

const AddSourceInputSchema = Schema.Struct({
  spec: OpenApiSpecInputSchema,
  name: Schema.String,
  baseUrl: Schema.String,
  namespace: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValueInputSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValueInputSchema)),
  oauth2: Schema.optional(OpenApiOAuthInputSchema),
  specFetchCredentials: Schema.optional(
    Schema.Struct({
      headers: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValueInputSchema)),
      queryParams: Schema.optional(Schema.Record(Schema.String, OpenApiConfiguredValueInputSchema)),
    }),
  ),
});

const AddSourceOutputSchema = Schema.Struct({
  sourceId: Schema.String,
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  toolCount: Schema.Number,
});
const GetSourceInputSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
});
const GetSourceOutputSchema = Schema.Struct({
  source: Schema.NullOr(Schema.Unknown),
});

const PreviewSpecInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(PreviewSpecInputSchema),
);
const PreviewSpecOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(StaticPreviewSpecOutputSchema),
);
const AddSourceInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(AddSourceInputSchema),
);
const AddSourceOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(AddSourceOutputSchema),
);
const OpenApiConfigureSourceInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(OpenApiConfigureSourceInputSchema),
);
const OpenApiConfigureSourceOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(Schema.Struct({ result: Schema.Array(CredentialBindingRef) })),
);
const GetSourceInputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(GetSourceInputSchema),
);
const GetSourceOutputStandardSchema = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(GetSourceOutputSchema),
);

const openApiToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

const openApiAuthToolFailure = (failure: OpenApiAuthRequiredError) =>
  authToolFailure({
    code: failure.code,
    message: failure.message,
    source: { id: failure.sourceId, scope: failure.sourceScope },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
      ...(failure.slotKey ? { slotKey: failure.slotKey } : {}),
      ...(failure.secretId ? { secretId: failure.secretId } : {}),
      ...(failure.connectionId ? { connectionId: failure.connectionId } : {}),
    },
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.details !== undefined
      ? {
          upstream: {
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            details: failure.details,
          },
        }
      : {}),
    recovery: { configureSourceTool: "executor.openapi.configureSource" },
  });

const staticPreviewOutput = (preview: SpecPreview): StaticPreviewSpecOutput => ({
  title: Option.getOrNull(preview.title),
  version: Option.getOrNull(preview.version),
  servers: preview.servers.map((server) => ({
    url: server.url,
    description: Option.getOrNull(server.description),
    variables: Option.getOrNull(server.variables)
      ? Object.fromEntries(
          Object.entries(Option.getOrNull(server.variables) ?? {}).map(([name, variable]) => [
            name,
            {
              default: variable.default,
              enum: Option.getOrNull(variable.enum),
              description: Option.getOrNull(variable.description),
            },
          ]),
        )
      : null,
  })),
  operationCount: preview.operationCount,
  tags: preview.tags,
  securitySchemes: preview.securitySchemes.map((scheme) => ({
    name: scheme.name,
    type: scheme.type,
    scheme: Option.getOrNull(scheme.scheme),
    bearerFormat: Option.getOrNull(scheme.bearerFormat),
    in: Option.getOrNull(scheme.in),
    headerName: Option.getOrNull(scheme.headerName),
    description: Option.getOrNull(scheme.description),
    flows: Option.isSome(scheme.flows)
      ? {
          authorizationCode: Option.isSome(scheme.flows.value.authorizationCode)
            ? {
                authorizationUrl: scheme.flows.value.authorizationCode.value.authorizationUrl,
                tokenUrl: scheme.flows.value.authorizationCode.value.tokenUrl,
                refreshUrl: Option.getOrNull(scheme.flows.value.authorizationCode.value.refreshUrl),
                scopes: scheme.flows.value.authorizationCode.value.scopes,
              }
            : null,
          clientCredentials: Option.isSome(scheme.flows.value.clientCredentials)
            ? {
                tokenUrl: scheme.flows.value.clientCredentials.value.tokenUrl,
                refreshUrl: Option.getOrNull(scheme.flows.value.clientCredentials.value.refreshUrl),
                scopes: scheme.flows.value.clientCredentials.value.scopes,
              }
            : null,
        }
      : null,
    openIdConnectUrl: Option.getOrNull(scheme.openIdConnectUrl),
  })),
  authStrategies: preview.authStrategies,
  headerPresets: preview.headerPresets,
  oauth2Presets: preview.oauth2Presets.map((preset) => ({
    label: preset.label,
    securitySchemeName: preset.securitySchemeName,
    flow: preset.flow,
    authorizationUrl: Option.getOrNull(preset.authorizationUrl),
    tokenUrl: preset.tokenUrl,
    refreshUrl: Option.getOrNull(preset.refreshUrl),
    scopes: preset.scopes,
  })),
});

const resolveStaticScopeInput = (
  ctx: { readonly scopes: readonly { readonly id: ScopeId; readonly name: string }[] },
  value: string,
): string =>
  String(
    ctx.scopes.find((scope) => scope.name === value || String(scope.id) === value)?.id ?? value,
  );

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
  OperationBinding.make({
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
  headers: Record<string, OpenApiConfiguredValueInput> | undefined,
): {
  readonly headers: Record<string, ConfiguredHeaderValue>;
} => {
  const nextHeaders: Record<string, ConfiguredHeaderValue> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      nextHeaders[name] = value;
      continue;
    }
    if (value.kind === "binding") {
      nextHeaders[name] = value;
      continue;
    }
    const slot = headerSlotFromName(name);
    nextHeaders[name] = ConfiguredHeaderBinding.make({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
  }
  return { headers: nextHeaders };
};

const canonicalizeCredentialMap = (
  values: Record<string, OpenApiConfiguredValueInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredHeaderValue>;
} => {
  const nextValues: Record<string, ConfiguredHeaderValue> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if (value.kind === "binding") {
      nextValues[name] = value;
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = ConfiguredHeaderBinding.make({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
  }
  return { values: nextValues };
};

const canonicalizeSpecFetchCredentials = (
  credentials:
    | {
        readonly headers?: Record<string, OpenApiConfiguredValueInput>;
        readonly queryParams?: Record<string, OpenApiConfiguredValueInput>;
      }
    | undefined,
): {
  readonly credentials?: SourceConfig["specFetchCredentials"];
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
  };
};

const canonicalizeOAuth2 = (
  oauth2: OpenApiOAuthInput | undefined,
): {
  readonly oauth2?: OAuth2SourceConfig;
} => {
  if (!oauth2) return {};
  return {
    oauth2,
  };
};

const configuredValueFromConfigureInput = (
  slot: string,
  input: OpenApiConfigureCredentialInput,
): {
  readonly configured: ConfiguredHeaderValue;
  readonly value: CredentialBindingValue;
} => {
  if (typeof input === "string") {
    return {
      configured: ConfiguredHeaderBinding.make({ kind: "binding", slot }),
      value: { kind: "text", text: input },
    };
  }
  if (input.kind === "text") {
    return {
      configured: ConfiguredHeaderBinding.make({
        kind: "binding",
        slot,
        prefix: input.prefix,
      }),
      value: { kind: "text", text: input.text },
    };
  }
  if (input.kind === "secret") {
    return {
      configured: ConfiguredHeaderBinding.make({
        kind: "binding",
        slot,
        prefix: input.prefix,
      }),
      value: {
        kind: "secret",
        secretId: SecretId.make(input.secretId),
        ...(input.secretScope ? { secretScopeId: ScopeId.make(input.secretScope) } : {}),
      },
    };
  }
  return {
    configured: ConfiguredHeaderBinding.make({ kind: "binding", slot }),
    value: { kind: "connection", connectionId: ConnectionId.make(input.connectionId) },
  };
};

const configureMap = (
  values: Record<string, OpenApiConfigureCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly configured: Record<string, ConfiguredHeaderValue>;
  readonly bindings: ReadonlyArray<{
    readonly slotKey: string;
    readonly value: CredentialBindingValue;
  }>;
} => {
  const configured: Record<string, ConfiguredHeaderValue> = {};
  const bindings: Array<{
    readonly slotKey: string;
    readonly value: CredentialBindingValue;
  }> = [];
  for (const [name, input] of Object.entries(values ?? {})) {
    const slotKey = slotForName(name);
    const next = configuredValueFromConfigureInput(slotKey, input);
    configured[name] = next.configured;
    bindings.push({ slotKey, value: next.value });
  }
  return { configured, bindings };
};

const configureOpenApiSource = (
  ctx: PluginCtx<OpenapiStore>,
  source: OpenApiSourceRef,
  input: OpenApiConfigureInput,
): Effect.Effect<readonly CredentialBindingRef[], StorageFailure> =>
  Effect.gen(function* () {
    const existing = yield* ctx.storage.getSource(source.id, source.scope);
    if (!existing) {
      return yield* new StorageError({
        message:
          `Cannot configure OpenAPI source "${source.id}" at scope "${source.scope}": ` +
          "source is not visible.",
        cause: undefined,
      });
    }

    const headers = configureMap(input.headers, headerSlotFromName);
    const queryParams = configureMap(input.queryParams, queryParamSlotFromName);
    const specFetchHeaders = configureMap(
      input.specFetchCredentials?.headers,
      specFetchHeaderSlotFromName,
    );
    const specFetchQueryParams = configureMap(
      input.specFetchCredentials?.queryParams,
      specFetchQueryParamSlotFromName,
    );
    const oauth2 = existing.config.oauth2;
    const oauth2Bindings: Array<{
      readonly slotKey: string;
      readonly value: CredentialBindingValue;
    }> = [];
    if (oauth2 && input.oauth2?.clientId) {
      oauth2Bindings.push({
        slotKey: oauth2.clientIdSlot,
        value: configuredValueFromConfigureInput(oauth2.clientIdSlot, input.oauth2.clientId).value,
      });
    }
    if (oauth2?.clientSecretSlot && input.oauth2?.clientSecret) {
      oauth2Bindings.push({
        slotKey: oauth2.clientSecretSlot,
        value: configuredValueFromConfigureInput(oauth2.clientSecretSlot, input.oauth2.clientSecret)
          .value,
      });
    }
    if (oauth2 && input.oauth2?.connection) {
      oauth2Bindings.push({
        slotKey: oauth2.connectionSlot,
        value: configuredValueFromConfigureInput(oauth2.connectionSlot, input.oauth2.connection)
          .value,
      });
    }

    const specFetchCredentials =
      input.specFetchCredentials === undefined
        ? existing.config.specFetchCredentials
        : {
            headers: specFetchHeaders.configured,
            queryParams: specFetchQueryParams.configured,
          };
    const affectedPrefixes = [
      ...(input.headers !== undefined ? ["header:"] : []),
      ...(input.queryParams !== undefined ? ["query_param:"] : []),
      ...(input.specFetchCredentials?.headers !== undefined ? ["spec_fetch:header:"] : []),
      ...(input.specFetchCredentials?.queryParams !== undefined ? ["spec_fetch:query_param:"] : []),
      ...(input.oauth2 !== undefined ? ["oauth2:"] : []),
    ];
    const bindings = [
      ...headers.bindings,
      ...queryParams.bindings,
      ...specFetchHeaders.bindings,
      ...specFetchQueryParams.bindings,
      ...oauth2Bindings,
    ];
    const nextConfiguredValues = (
      current: Record<string, ConfiguredHeaderValue> | undefined,
      next: Record<string, ConfiguredHeaderValue>,
      provided: boolean,
    ): Record<string, ConfiguredHeaderValue> | undefined => {
      if (!provided) return current;
      if (Object.keys(next).length === 0) return {};
      return { ...(current ?? {}), ...next };
    };

    return yield* ctx.transaction(
      Effect.gen(function* () {
        yield* ctx.storage.updateSourceMeta(source.id, source.scope, {
          headers: nextConfiguredValues(
            existing.config.headers,
            headers.configured,
            input.headers !== undefined,
          ),
          queryParams: nextConfiguredValues(
            existing.config.queryParams,
            queryParams.configured,
            input.queryParams !== undefined,
          ),
          specFetchCredentials,
        });
        if (affectedPrefixes.length > 0 || bindings.length > 0) {
          return yield* ctx.credentialBindings.replaceForSource({
            targetScope: ScopeId.make(input.scope),
            pluginId: OPENAPI_PLUGIN_ID,
            sourceId: source.id,
            sourceScope: ScopeId.make(source.scope),
            slotPrefixes: affectedPrefixes,
            bindings,
          });
        }
        return [];
      }),
    );
  });

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

const resolveOpenApiCredentialBinding = (
  ctx: PluginCtx<OpenapiStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<CredentialBindingRef | null, StorageFailure> =>
  ctx.credentialBindings.resolveBinding({
    pluginId: OPENAPI_PLUGIN_ID,
    sourceId,
    sourceScope: ScopeId.make(sourceScope),
    slotKey: slot,
  });

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
): Effect.Effect<Record<string, string>, OpenApiAuthRequiredError | StorageFailure> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = yield* resolveOpenApiCredentialBinding(
        ctx,
        params.sourceId,
        params.sourceScope,
        value.slot,
      );
      if (binding?.value.kind === "secret") {
        const secretBinding = binding.value;
        const secret = yield* ctx.secrets
          .getAtScope(secretBinding.secretId, secretBinding.secretScopeId ?? binding.scopeId)
          .pipe(
            Effect.catchTag("SecretOwnedByConnectionError", () =>
              Effect.fail(
                new OpenApiAuthRequiredError({
                  code: "credential_secret_missing",
                  sourceId: params.sourceId,
                  sourceScope: params.sourceScope,
                  credentialKind: "secret",
                  credentialLabel: name,
                  slotKey: value.slot,
                  secretId: String(secretBinding.secretId),
                  message: `Secret not found for ${params.missingLabel} "${name}"`,
                }),
              ),
            ),
          );
        if (secret === null) {
          return yield* new OpenApiAuthRequiredError({
            code: "credential_secret_missing",
            sourceId: params.sourceId,
            sourceScope: params.sourceScope,
            credentialKind: "secret",
            credentialLabel: name,
            slotKey: value.slot,
            secretId: String(secretBinding.secretId),
            message: `Missing secret "${secretBinding.secretId}" for ${params.missingLabel} "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      return yield* new OpenApiAuthRequiredError({
        code: "credential_binding_missing",
        sourceId: params.sourceId,
        sourceScope: params.sourceScope,
        credentialKind: "secret",
        credentialLabel: name,
        slotKey: value.slot,
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
): Effect.Effect<Record<string, string>, OpenApiAuthRequiredError | StorageFailure> =>
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
    const binding = yield* resolveOpenApiCredentialBinding(
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
  credentials: OpenApiPreviewSpecFetchCredentialsInput | undefined,
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
  }).pipe(
    Effect.catchTag("OpenApiAuthRequiredError", ({ message }) =>
      Effect.fail(new OpenApiOAuthError({ message })),
    ),
  );

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
    if (typeof value === "string") {
      configHeaders[name] = value;
    }
  }
  return {
    kind: "openapi",
    spec: specInputToConfigString(config.spec),
    baseUrl: config.baseUrl,
    namespace,
    headers: headersToConfigValues(
      Object.keys(configHeaders).length > 0 ? configHeaders : undefined,
    ),
  };
};

const specInputToConfigString = (spec: OpenApiSpecInput): string =>
  spec.kind === "url" ? spec.url : spec.value;

export const openApiPlugin = definePlugin((options?: OpenApiPluginOptions) => {
  type RebuildInput = {
    readonly specText: string;
    readonly scope: string;
    readonly sourceUrl?: string;
    readonly name: string;
    readonly baseUrl: string | undefined;
    readonly namespace: string;
    readonly headers?: Record<string, OpenApiConfiguredValueInput>;
    readonly queryParams?: Record<string, OpenApiConfiguredValueInput>;
    readonly specFetchCredentials?: {
      readonly headers?: Record<string, OpenApiConfiguredValueInput>;
      readonly queryParams?: Record<string, OpenApiConfiguredValueInput>;
    };
    readonly oauth2?: OpenApiOAuthInput;
  };

  // ctx comes from the plugin runtime — the same instance is passed to
  // `extension(ctx)` and to every lifecycle hook (`refreshSource`, etc.),
  // so helpers parameterised on ctx can be called from either surface.
  const rebuildSource = (ctx: PluginCtx<OpenapiStore>, input: RebuildInput) =>
    Effect.gen(function* () {
      const doc = yield* parse(input.specText);
      const result = yield* extract(doc);

      const namespace = input.namespace;
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

      const baseUrl = outerSource ? undefined : input.baseUrl;
      const canonicalHeaders = canonicalizeHeaders(input.headers);
      const canonicalQueryParams = canonicalizeCredentialMap(
        input.queryParams,
        queryParamSlotFromName,
      );
      const canonicalSpecFetchCredentials = canonicalizeSpecFetchCredentials(
        input.specFetchCredentials,
      );
      const canonicalOAuth2 = canonicalizeOAuth2(input.oauth2);
      const definitions = compileToolDefinitions(result.operations);
      const sourceName = input.name;

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
        baseUrl: existing.config.baseUrl,
        namespace: existing.namespace,
        headers: existing.config.headers,
        queryParams: existing.config.queryParams,
        specFetchCredentials: existing.config.specFetchCredentials,
        oauth2: existing.config.oauth2,
      });
    });

  return {
    id: "openapi" as const,
    packageName: "@executor-js/plugin-openapi",
    sourcePresets: openApiPresets,
    schema: openapiSchema,
    storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

    extension: (ctx) => {
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
      const addSpecInternal = (config: OpenApiSpecConfig) =>
        Effect.gen(function* () {
          // Resolve URL → text and parse BEFORE opening a transaction.
          // Holding `BEGIN` on the pool=1 Postgres connection across a
          // network fetch is the Hyperdrive deadlock path in production.
          const specText =
            config.spec.kind === "url"
              ? yield* resolveSpecText(config.spec.url).pipe(Effect.provide(httpClientLayer))
              : config.spec.value;
          return yield* rebuildSource(ctx, {
            specText,
            scope: config.scope,
            sourceUrl: config.spec.kind === "url" ? config.spec.url : undefined,
            name: config.name,
            baseUrl: config.baseUrl,
            namespace: config.namespace,
            headers: config.headers,
            queryParams: config.queryParams,
            specFetchCredentials: config.specFetchCredentials,
            oauth2: config.oauth2,
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

        configure: (source: OpenApiSourceRef, input: OpenApiConfigureInput) =>
          configureOpenApiSource(ctx, source, input),
      };
    },

    sourceConfigure: {
      type: "openapi",
      schema: OpenApiConfigureInputSchema,
      configure: ({ ctx, sourceId, sourceScope, config }) =>
        Effect.gen(function* () {
          const input = config as OpenApiConfigureInput;
          if (
            input.name !== undefined ||
            input.baseUrl !== undefined ||
            input.oauth2Source !== undefined
          ) {
            if (input.baseUrl !== undefined && input.baseUrl.trim() !== "") {
              const outerSource = yield* findOuterSource(ctx, sourceId, sourceScope);
              if (outerSource) {
                return yield* new OpenApiOAuthError({
                  message: "OpenAPI source shadows inherit the outer source base URL",
                });
              }
            }
            yield* ctx.storage.updateSourceMeta(sourceId, sourceScope, {
              name: input.name?.trim() || undefined,
              baseUrl: input.baseUrl,
              oauth2: input.oauth2Source,
            });
          }
          return yield* configureOpenApiSource(ctx, { id: sourceId, scope: sourceScope }, input);
        }),
    },

    staticSources: (self) => [
      {
        id: "openapi",
        kind: "executor",
        name: "OpenAPI",
        tools: [
          tool({
            name: "previewSpec",
            description:
              "Preview an OpenAPI document before adding it as a source. Call this first when the user provides a spec URL/blob so you can inspect servers, auth schemes, operation count, tags, and credential slots before `addSource`. This agent-facing preview intentionally omits the full operations list; use `operationCount` and `tags` for full-size specs. Do not collect API keys or OAuth client secrets in chat; use `executor.coreTools.secrets.create` for those values.",
            inputSchema: PreviewSpecInputStandardSchema,
            outputSchema: PreviewSpecOutputStandardSchema,
            execute: (input) =>
              self.previewSpec(input).pipe(
                Effect.map((preview) => ToolResult.ok(staticPreviewOutput(preview))),
                Effect.catchTags({
                  OpenApiParseError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_parse_failed", message)),
                  OpenApiExtractionError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_extraction_failed", message)),
                  OpenApiOAuthError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_oauth_failed", message)),
                }),
              ),
          }),
          tool({
            name: "getSource",
            description:
              "Inspect an existing OpenAPI source, including effective base URL, configured headers/query params, OAuth settings, and stored credential slots. Use this before repairing an existing source with `openapi.configureSource`, `secrets.create`, or `oauth.start`.",
            inputSchema: GetSourceInputStandardSchema,
            outputSchema: GetSourceOutputStandardSchema,
            execute: (input, { ctx }) =>
              Effect.map(
                self.getSource(input.namespace, resolveStaticScopeInput(ctx, input.scope)),
                (source) => ToolResult.ok({ source }),
              ),
          }),
          tool({
            name: "addSource",
            description:
              "Add an OpenAPI source and register its operations as tools. Executor chooses the source install scope (local scope locally, organization scope in cloud) and returns it as `source`. Recommended flow: call `previewSpec`, choose or confirm namespace/name/baseUrl from the preview (baseUrl is only needed when the spec cannot infer one or the user wants an override), declare credential slots here for sensitive headers/query params, then call `secrets.create` and `openapi.configureSource` with the user's chosen credential scope for per-scope bindings. Use `oauth.start` with `credentialScope` set to the user's chosen personal or organization credential scope for browser OAuth sign-in.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add an OpenAPI source",
            },
            inputSchema: AddSourceInputStandardSchema,
            outputSchema: AddSourceOutputStandardSchema,
            execute: (input, { ctx }) => {
              const sourceScope = defaultSourceInstallScopeId(ctx.scopes);
              if (sourceScope === null) {
                return Effect.succeed(
                  openApiToolFailure(
                    "source_scope_unavailable",
                    "Cannot add an OpenAPI source because this executor has no source install scope.",
                  ),
                );
              }
              return self.addSpec({ ...input, scope: sourceScope }).pipe(
                Effect.map((result) =>
                  ToolResult.ok({
                    ...result,
                    source: { id: result.sourceId, scope: sourceScope },
                  }),
                ),
                Effect.catchTags({
                  OpenApiParseError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_parse_failed", message)),
                  OpenApiExtractionError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_extraction_failed", message)),
                  OpenApiOAuthError: ({ message }) =>
                    Effect.succeed(openApiToolFailure("openapi_oauth_failed", message)),
                }),
              );
            },
          }),
          tool({
            name: "configureSource",
            description:
              'Configure an existing OpenAPI source with concrete fields. Use `source` returned by `openapi.addSource` or `sources.list`. The top-level `scope` is the credential target scope for bindings; in cloud, choose the user or organization credential scope deliberately. Pass secret refs as `{kind:"secret", secretId}` and OAuth connections as `{kind:"connection", connectionId}`.',
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure an OpenAPI source",
            },
            inputSchema: OpenApiConfigureSourceInputStandardSchema,
            outputSchema: OpenApiConfigureSourceOutputStandardSchema,
            execute: (input, { ctx }) => {
              const { source, ...config } = input as typeof OpenApiConfigureSourceInputSchema.Type;
              const sourceScope = resolveStaticScopeInput(ctx, source.scope);
              const targetScope = resolveStaticScopeInput(ctx, config.scope);
              return Effect.map(
                self.configure(
                  { id: source.id, scope: sourceScope },
                  { ...config, scope: targetScope },
                ),
                (result) => ToolResult.ok({ result }),
              );
            },
          }),
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        // toolRow.scope_id is the resolved owning scope of the tool
        // (innermost-wins from the executor's stack). The matching
        // OpenAPI operation + source plugin-storage rows live at the same
        // scope, so pin every store lookup to it instead of relying on
        // stack-wide scope fall-through.
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
          const oauth2 = config.oauth2;
          const connection = yield* resolveOAuthConnectionId(ctx, {
            sourceId: op.sourceId,
            sourceScope: effective.oauth2Source.scope,
            oauth2,
          });
          if (!connection) {
            return yield* new OpenApiAuthRequiredError({
              code: "oauth_connection_missing",
              sourceId: op.sourceId,
              sourceScope: effective.oauth2Source.scope,
              credentialKind: "connection",
              credentialLabel:
                oauth2.flow === "clientCredentials" ? "OAuth client connection" : "OAuth sign-in",
              slotKey: oauth2.connectionSlot,
              message: `OAuth configuration for "${op.sourceId}" is missing a connection binding`,
            });
          }
          const accessToken = yield* ctx.connections
            .accessTokenAtScope(connection.connectionId, connection.scopeId)
            .pipe(
              Effect.catchTags({
                ConnectionReauthRequiredError: ({ message, connectionId }) =>
                  Effect.fail(
                    new OpenApiAuthRequiredError({
                      code: "oauth_reauth_required",
                      sourceId: op.sourceId,
                      sourceScope: effective.oauth2Source.scope,
                      credentialKind: "oauth",
                      credentialLabel:
                        oauth2.flow === "clientCredentials"
                          ? "OAuth client connection"
                          : "OAuth sign-in",
                      slotKey: oauth2.connectionSlot,
                      connectionId: String(connectionId),
                      message: `OAuth connection "${connectionId}" needs re-authentication: ${message}`,
                    }),
                  ),
                ConnectionNotFoundError: ({ connectionId }) =>
                  Effect.fail(
                    new OpenApiAuthRequiredError({
                      code: "oauth_connection_missing",
                      sourceId: op.sourceId,
                      sourceScope: effective.oauth2Source.scope,
                      credentialKind: "connection",
                      credentialLabel:
                        oauth2.flow === "clientCredentials"
                          ? "OAuth client connection"
                          : "OAuth sign-in",
                      slotKey: oauth2.connectionSlot,
                      connectionId: String(connectionId),
                      message: `OAuth connection "${connectionId}" was not found for "${op.sourceId}"`,
                    }),
                  ),
                ConnectionProviderNotRegisteredError: ({ provider }) =>
                  Effect.fail(
                    new OpenApiAuthRequiredError({
                      code: "oauth_connection_failed",
                      sourceId: op.sourceId,
                      sourceScope: effective.oauth2Source.scope,
                      credentialKind: "oauth",
                      credentialLabel:
                        oauth2.flow === "clientCredentials"
                          ? "OAuth client connection"
                          : "OAuth sign-in",
                      slotKey: oauth2.connectionSlot,
                      connectionId: connection.connectionId,
                      message: `OAuth provider "${provider}" is not registered`,
                    }),
                  ),
                ConnectionRefreshNotSupportedError: ({ provider, connectionId }) =>
                  Effect.fail(
                    new OpenApiAuthRequiredError({
                      code: "oauth_connection_failed",
                      sourceId: op.sourceId,
                      sourceScope: effective.oauth2Source.scope,
                      credentialKind: "oauth",
                      credentialLabel:
                        oauth2.flow === "clientCredentials"
                          ? "OAuth client connection"
                          : "OAuth sign-in",
                      slotKey: oauth2.connectionSlot,
                      connectionId: String(connectionId),
                      message: `OAuth provider "${provider}" cannot refresh connection "${connectionId}"`,
                    }),
                  ),
                ConnectionRefreshError: ({ message, connectionId }) =>
                  Effect.fail(
                    new OpenApiAuthRequiredError({
                      code: "oauth_connection_failed",
                      sourceId: op.sourceId,
                      sourceScope: effective.oauth2Source.scope,
                      credentialKind: "oauth",
                      credentialLabel:
                        oauth2.flow === "clientCredentials"
                          ? "OAuth client connection"
                          : "OAuth sign-in",
                      slotKey: oauth2.connectionSlot,
                      connectionId: String(connectionId),
                      message: `OAuth connection "${connectionId}" refresh failed: ${message}`,
                    }),
                  ),
              }),
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

        const ok = result.status >= 200 && result.status < 300;
        if (!ok) {
          if (result.status === 401 || result.status === 403) {
            return authToolFailure({
              code: "credential_rejected",
              status: result.status,
              message: `Upstream rejected credentials for "${op.sourceId}" with HTTP ${result.status}. Re-authenticate or update the source credentials before retrying this tool.`,
              source: { id: op.sourceId, scope: toolScope },
              credential: { kind: "upstream", label: "Upstream authorization" },
              upstream: { status: result.status, details: result.error },
              recovery: { configureSourceTool: "executor.openapi.configureSource" },
            });
          }
          return ToolResult.fail({
            code: "upstream_http_error",
            status: result.status,
            message: extractUpstreamMessage(result.error, result.status),
            details: result.error,
          });
        }
        return ToolResult.ok({
          status: result.status,
          headers: result.headers,
          data: result.data,
        });
      }).pipe(
        Effect.catchTag("OpenApiAuthRequiredError", (error) =>
          Effect.succeed(openApiAuthToolFailure(error)),
        ),
      ),

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
        if (options?.configFile) {
          yield* options.configFile.removeSource(sourceId);
        }
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
        return SourceDetectionResult.make({
          kind: "openapi",
          confidence: "high",
          endpoint: trimmed,
          name,
          namespace,
        });
      }),
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-openapi/api`. Hosts that
  // want the HTTP surface import the plugin from there; SDK-only
  // consumers stay on this entry and avoid the server-only deps.
});
