import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  IntegrationAlreadyExistsError,
  IntegrationDetectionResult,
  IntegrationSlug,
  ToolName,
  ToolResult,
  authToolFailure,
  definePlugin,
  tool,
  type AuthMethodDescriptor,
  type AuthPlacementDescriptor,
  type Integration,
  type IntegrationConfig,
  type IntegrationRecord,
  type PluginCtx,
  type ResolveToolsResult,
  type StorageFailure,
  type ToolDef,
  type ToolInvocationCredential,
} from "@executor-js/sdk/core";

import {
  decodeOpenApiIntegrationConfig,
  renderAuthTemplate,
  requiredTemplateVariables,
  type OpenApiIntegrationConfig,
} from "./config";
import { OpenApiExtractionError, OpenApiOAuthError, OpenApiParseError } from "./errors";
import { parse, resolveSpecText } from "./parse";
import {
  convertGoogleDiscoveryBundleToOpenApi,
  convertGoogleDiscoveryToOpenApi,
  fetchGoogleDiscoveryDocument,
  isGoogleDiscoveryUrl,
} from "./google-discovery";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { annotationsForOperation, invokeWithLayer } from "./invoke";
import { previewSpec, type SpecPreview } from "./preview";
import { openApiPresets } from "./presets";
import { makeDefaultOpenapiStore, type OpenapiStore, type StoredOperation } from "./store";
import type { Authentication, AuthenticationTemplateValue } from "./types";
import { OperationBinding, TOKEN_VARIABLE } from "./types";

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
    .map(
      ({
        detail,
        message: upstreamMessage,
        title,
      }: {
        detail?: string;
        message?: string;
        title?: string;
      }) => firstNonEmpty(detail, upstreamMessage, title),
    )
    .find((message: string | undefined) => message !== undefined);
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

// ---------------------------------------------------------------------------
// Extension input shapes
// ---------------------------------------------------------------------------

export type OpenApiSpecInput = typeof OpenApiSpecInputSchema.Type;

export interface OpenApiPreviewInput {
  readonly spec: string;
}

/** Add an OpenAPI integration to the catalog. The integration is the API
 *  surface; connections (the credentials) are attached separately and resolve
 *  their value through the declared `authenticationTemplate`. */
export interface OpenApiSpecConfig {
  readonly spec: OpenApiSpecInput;
  /** The catalog slug for the new integration (the `<integration>` segment). */
  readonly slug: string;
  /** Human description (defaults to the spec title). */
  readonly description?: string;
  readonly baseUrl?: string;
  /** Static headers applied to every request (no secret material). */
  readonly headers?: Record<string, string>;
  /** Static query params applied to every request. */
  readonly queryParams?: Record<string, string>;
  /** Auth methods a connection's value renders through. */
  readonly authenticationTemplate?: readonly Authentication[];
}

export interface OpenApiExtensionFailure {
  readonly _tag: string;
}

/** Add / merge custom auth methods onto an existing OpenAPI integration's
 *  `authenticationTemplate`. Mirrors the GraphQL plugin's `configure`. */
export interface OpenApiConfigureInput {
  /** The auth methods to add. Each entry is appended to (or, when its `slug`
   *  already exists, replaces) the integration's existing template array. A
   *  custom apiKey method with no `slug` is assigned a generated `custom_<id>`
   *  slug that is collision-checked against the existing template. */
  readonly authenticationTemplate: readonly Authentication[];
  readonly mode?: "merge" | "replace";
}

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
    { readonly slug: IntegrationSlug; readonly toolCount: number },
    | OpenApiParseError
    | OpenApiExtractionError
    | OpenApiOAuthError
    | IntegrationAlreadyExistsError
    | StorageFailure
  >;
  readonly removeSpec: (slug: string) => Effect.Effect<void, StorageFailure>;
  readonly getIntegration: (slug: string) => Effect.Effect<Integration | null, StorageFailure>;
  /** Read the integration's full opaque config, including its
   *  `authenticationTemplate`. Returns null when the integration is absent. */
  readonly getConfig: (
    slug: string,
  ) => Effect.Effect<OpenApiIntegrationConfig | null, StorageFailure>;
  /** Add / merge custom auth methods onto the integration's
   *  `authenticationTemplate`. Returns the resulting template array. */
  readonly configure: (
    slug: string,
    input: OpenApiConfigureInput,
  ) => Effect.Effect<readonly Authentication[], StorageFailure>;
}

// ---------------------------------------------------------------------------
// Control-tool input/output schemas
// ---------------------------------------------------------------------------

const PreviewSpecInputSchema = Schema.Struct({
  spec: Schema.String,
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
  identityScopes: Schema.Union([
    Schema.Literal("auto"),
    Schema.Literal(false),
    Schema.Array(Schema.String),
  ]),
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
  Schema.Struct({
    kind: Schema.Literal("googleDiscovery"),
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("googleDiscoveryBundle"),
    urls: Schema.Array(Schema.String),
  }),
]);

const AuthenticationVariableSchema = Schema.Struct({
  type: Schema.Literal("variable"),
  name: Schema.String,
});
const AuthenticationTemplateValueSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.String, AuthenticationVariableSchema])),
]);
const AuthenticationSchema = Schema.Union([
  Schema.Struct({
    slug: Schema.String,
    type: Schema.Literal("apiKey"),
    headers: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValueSchema)),
    queryParams: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValueSchema)),
  }),
  Schema.Struct({
    slug: Schema.String,
    type: Schema.Literal("oauth"),
    authorizationUrl: Schema.String,
    tokenUrl: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
]);

const AddSourceInputSchema = Schema.Struct({
  spec: OpenApiSpecInputSchema,
  slug: Schema.String,
  description: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
});

const AddSourceOutputSchema = Schema.Struct({
  slug: Schema.String,
  toolCount: Schema.Number,
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

const openApiToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

const openApiAuthToolFailure = (failure: {
  readonly code: string;
  readonly message: string;
  readonly owner: "org" | "user";
  readonly integration: string;
  readonly connection: string;
  readonly credentialKind: "secret" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly status?: number;
  readonly details?: unknown;
}) =>
  authToolFailure({
    // The auth-tool-failure helper's code set is shared with v1; keep the
    // string but reference the connection rather than v1's source/slot.
    code: failure.code as Parameters<typeof authToolFailure>[0]["code"],
    message: failure.message,
    source: { id: failure.integration, scope: failure.owner },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
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
    identityScopes: preset.identityScopes,
  })),
});

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
    baseUrl: def.operation.baseUrl,
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

const openApiTransportOutputSchema = (dataSchema: unknown): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  required: ["status", "headers", "data"],
  properties: {
    status: { type: "integer" },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    data: dataSchema ?? {},
  },
});

const specInputToSourceUrl = (spec: OpenApiSpecInput): string | undefined =>
  spec.kind === "url" || spec.kind === "googleDiscovery" ? spec.url : undefined;

const specInputToGoogleBundle = (spec: OpenApiSpecInput): readonly string[] | undefined =>
  spec.kind === "googleDiscoveryBundle" ? spec.urls : undefined;

// ---------------------------------------------------------------------------
// Auth-template merge — `configure` appends custom methods to the integration's
// existing `authenticationTemplate`. A method whose slug matches an existing
// entry replaces it (in place); a method with no usable slug is assigned a
// generated `custom_<id>` slug, collision-checked against the merged set so two
// custom methods added in one call can't clash.
// ---------------------------------------------------------------------------

const shortId = (): string => Math.random().toString(36).slice(2, 8);

/** Generate a `custom_<id>` slug not present in `taken`. */
const freshCustomSlug = (taken: ReadonlySet<string>): AuthTemplateSlug => {
  let candidate = `custom_${shortId()}`;
  while (taken.has(candidate)) candidate = `custom_${shortId()}`;
  return AuthTemplateSlug.make(candidate);
};

/** Merge incoming auth methods into the existing template array. Entries with a
 *  matching slug replace the existing entry; otherwise they are appended.
 *  Incoming entries lacking a slug (or whose slug collides with another entry
 *  added in this same call) get a fresh `custom_<id>` slug. */
const mergeAuthenticationTemplate = (
  existing: readonly Authentication[],
  incoming: readonly Authentication[],
): readonly Authentication[] => {
  const result: Authentication[] = existing.map((entry) => entry);
  const taken = new Set<string>(result.map((entry) => String(entry.slug)));
  for (const entry of incoming) {
    // `slug` is branded as required, but JSON callers may omit it; read defensively.
    const rawSlug = (entry as { readonly slug?: unknown }).slug;
    const requested = typeof rawSlug === "string" ? rawSlug.trim() : "";
    const existingIndex = result.findIndex((current) => String(current.slug) === requested);
    if (requested.length > 0 && existingIndex >= 0) {
      // Replace the matching entry in place, preserving array order.
      result[existingIndex] = entry;
      continue;
    }
    const slug =
      requested.length > 0 && !taken.has(requested)
        ? AuthTemplateSlug.make(requested)
        : freshCustomSlug(taken);
    taken.add(String(slug));
    result.push({ ...entry, slug } as Authentication);
  }
  return result;
};

// ---------------------------------------------------------------------------
// Declared auth methods — project the stored `authenticationTemplate` into the
// catalog's plugin-agnostic `AuthMethodDescriptor[]`. This mirrors the client's
// `authMethodsFromConfig` (in the React auth-method-config module) on the
// server so the catalog field is consistent. OpenAPI also renders its own
// accounts slot, so this projection is consistency work, not a fix; an absent /
// malformed config yields `[]` with no regression.
//
// Placement prefix extraction: a header/query slot serializes the credential as
// `name -> [prefix, variable("token")]`; the leading literals before the
// `variable("token")` part are the prefix (empty for a bare `[token]`).
// ---------------------------------------------------------------------------

/** Extract the literal prefix preceding the credential variable, plus the
 *  variable name a placement renders from (`token` for single-input methods, a
 *  distinct name per input for multi-input ones). */
const parseTemplateValue = (
  value: AuthenticationTemplateValue,
): { readonly prefix: string; readonly variable: string } => {
  if (typeof value === "string") return { prefix: "", variable: TOKEN_VARIABLE };
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part !== "string" && part.type === "variable") {
      return { prefix: parts.join(""), variable: part.name };
    }
    if (typeof part === "string") parts.push(part);
  }
  return { prefix: parts.join(""), variable: TOKEN_VARIABLE };
};

const placementsFromAuthentication = (
  template: Extract<Authentication, { readonly type: "apiKey" }>,
): readonly AuthPlacementDescriptor[] => {
  const placements: AuthPlacementDescriptor[] = [];
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    const { prefix, variable } = parseTemplateValue(value);
    placements.push({ carrier: "header", name, prefix, variable });
  }
  for (const [name, value] of Object.entries(template.queryParams ?? {})) {
    const { prefix, variable } = parseTemplateValue(value);
    placements.push({ carrier: "query", name, prefix, variable });
  }
  return placements;
};

const apiKeyLabel = (slug: string, placements: readonly AuthPlacementDescriptor[]): string => {
  const first = placements[0];
  if (first) return `API key (${first.name || (first.carrier === "header" ? "header" : "query")})`;
  return `API key (${slug})`;
};

export const describeOpenApiAuthMethods = (
  record: IntegrationRecord,
): readonly AuthMethodDescriptor[] => {
  const config = decodeOpenApiIntegrationConfig(record.config);
  if (!config) return [];
  return (config.authenticationTemplate ?? []).map(
    (template: Authentication): AuthMethodDescriptor => {
      const slug = String(template.slug);
      if (template.type === "oauth") {
        return {
          id: slug,
          label: "OAuth2",
          kind: "oauth",
          template: slug,
          oauth: {
            authorizationUrl: template.authorizationUrl,
            tokenUrl: template.tokenUrl,
            scopes: template.scopes,
          },
        };
      }
      const placements = placementsFromAuthentication(template);
      return {
        id: slug,
        label: apiKeyLabel(slug, placements),
        kind: "apikey",
        template: slug,
        placements,
      };
    },
  );
};

export const describeOpenApiIntegrationDisplay = (
  record: IntegrationRecord,
): { readonly url?: string } => {
  const config = decodeOpenApiIntegrationConfig(record.config);
  return { url: config?.baseUrl ?? config?.sourceUrl };
};

// ---------------------------------------------------------------------------
// Spec → tool definitions (shared by addSpec, resolveTools, and detect)
// ---------------------------------------------------------------------------

interface CompiledSpec {
  readonly definitions: readonly ToolDefinition[];
  readonly hoistedDefs: Record<string, unknown>;
  readonly title: string | undefined;
}

const compileSpec = (
  specText: string,
): Effect.Effect<CompiledSpec, OpenApiParseError | OpenApiExtractionError> =>
  Effect.gen(function* () {
    const doc = yield* parse(specText);
    const result = yield* extract(doc);
    const hoistedDefs: Record<string, unknown> = {};
    if (doc.components?.schemas) {
      for (const [k, v] of Object.entries(doc.components.schemas)) {
        hoistedDefs[k] = normalizeOpenApiRefs(v);
      }
    }
    return {
      definitions: compileToolDefinitions(result.operations),
      hoistedDefs,
      title: Option.getOrUndefined(result.title),
    };
  });

// A tool's name carries its structured `group.leaf` path verbatim (e.g.
// `aliases.deleteAlias`). The address grammar
// `tools.<integration>.<owner>.<connection>.<tool>` treats `<tool>` as the
// trailing remainder (see parseToolAddress), so the dotted path needs no
// flattening — it nests naturally as
// `tools.<integration>.<owner>.<connection>.aliases.deleteAlias`, matching how
// the sandbox `tools` proxy joins property access.

const toolDefsFromCompiled = (compiled: CompiledSpec): readonly ToolDef[] =>
  compiled.definitions.map(
    (def): ToolDef => ({
      name: ToolName.make(def.toolPath),
      description: descriptionFor(def),
      inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(def.operation.inputSchema)),
      outputSchema: openApiTransportOutputSchema(
        normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
      ),
      annotations: annotationsForOperation(def.operation.method, def.operation.pathTemplate),
    }),
  );

const storedOperationsFromCompiled = (
  integration: string,
  compiled: CompiledSpec,
): readonly StoredOperation[] =>
  compiled.definitions.map((def) => ({
    integration,
    toolName: def.toolPath,
    binding: toBinding(def),
  }));

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OpenApiPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
}

const fetchGoogleDiscoveryBundleConversion = (
  urls: readonly string[],
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
) =>
  Effect.forEach(
    urls,
    (url) =>
      fetchGoogleDiscoveryDocument(url).pipe(
        Effect.provide(httpClientLayer),
        Effect.map((documentText) => ({ discoveryUrl: url, documentText })),
      ),
    { concurrency: 4 },
  ).pipe(Effect.flatMap((documents) => convertGoogleDiscoveryBundleToOpenApi({ documents })));

export const openApiPlugin = definePlugin((options?: OpenApiPluginOptions) => {
  const resolveSpecForInput = (
    spec: OpenApiSpecInput,
    httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
  ): Effect.Effect<
    {
      readonly specText: string;
      readonly baseUrl?: string;
      // The Google Discovery converters derive the `googleOAuth2` oauth template
      // straight from the spec's declared scopes. `addSpec` adopts it when the
      // caller didn't pass an explicit `authenticationTemplate` (the bundle add
      // path has no preview to detect auth from).
      readonly authenticationTemplate?: readonly Authentication[];
    },
    OpenApiParseError | OpenApiExtractionError | OpenApiOAuthError
  > =>
    Effect.gen(function* () {
      if (spec.kind === "googleDiscovery") {
        const conversion = yield* fetchGoogleDiscoveryDocument(spec.url).pipe(
          Effect.provide(httpClientLayer),
          Effect.flatMap((documentText) =>
            convertGoogleDiscoveryToOpenApi({
              discoveryUrl: spec.url,
              documentText,
            }),
          ),
        );
        return {
          specText: conversion.specText,
          baseUrl: conversion.baseUrl,
          ...(conversion.authenticationTemplate
            ? { authenticationTemplate: conversion.authenticationTemplate }
            : {}),
        };
      }
      if (spec.kind === "googleDiscoveryBundle") {
        const conversion = yield* fetchGoogleDiscoveryBundleConversion(spec.urls, httpClientLayer);
        return {
          specText: conversion.specText,
          baseUrl: conversion.baseUrl,
          ...(conversion.authenticationTemplate
            ? { authenticationTemplate: conversion.authenticationTemplate }
            : {}),
        };
      }
      if (spec.kind === "url") {
        const specText = yield* resolveSpecText(spec.url).pipe(Effect.provide(httpClientLayer));
        return { specText };
      }
      return { specText: spec.value };
    });

  return {
    id: "openapi" as const,
    packageName: "@executor-js/plugin-openapi",
    integrationPresets: openApiPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      summary: preset.summary,
      ...(preset.url ? { url: preset.url } : {}),
      ...(preset.icon ? { icon: preset.icon } : {}),
      ...(preset.featured ? { featured: preset.featured } : {}),
    })),
    storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

    extension: (ctx: PluginCtx<OpenapiStore>) => {
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;

      const addSpec = (config: OpenApiSpecConfig) =>
        Effect.gen(function* () {
          // Resolve URL → text and parse BEFORE opening a transaction. Holding
          // `BEGIN` across a network fetch is the Hyperdrive deadlock path.
          const resolved = yield* resolveSpecForInput(config.spec, httpClientLayer);
          const compiled = yield* compileSpec(resolved.specText);

          const slug = IntegrationSlug.make(config.slug);

          // Block re-adding an existing slug. The core `integrations.register`
          // primitive upserts (so boot re-registration is idempotent), but an
          // explicit add must NOT silently clobber an existing integration's
          // tools, connections, and policies. To add more auth, update the
          // existing integration instead.
          const existing = yield* ctx.core.integrations.get(slug);
          if (existing) {
            return yield* new IntegrationAlreadyExistsError({ slug });
          }

          const integrationConfig: OpenApiIntegrationConfig = {
            spec: resolved.specText,
            ...(specInputToSourceUrl(config.spec) !== undefined
              ? { sourceUrl: specInputToSourceUrl(config.spec) }
              : {}),
            ...(specInputToGoogleBundle(config.spec) !== undefined
              ? { googleDiscoveryUrls: specInputToGoogleBundle(config.spec) }
              : {}),
            ...((config.baseUrl ?? resolved.baseUrl)
              ? { baseUrl: config.baseUrl ?? resolved.baseUrl }
              : {}),
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.queryParams ? { queryParams: config.queryParams } : {}),
            // Prefer the caller's explicit template; otherwise adopt the one the
            // Google Discovery converter derived from the spec (the bundle add
            // path relies on this — it has no preview to detect auth from).
            ...(config.authenticationTemplate
              ? { authenticationTemplate: config.authenticationTemplate }
              : resolved.authenticationTemplate
                ? { authenticationTemplate: resolved.authenticationTemplate }
                : {}),
          };

          yield* ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.core.integrations.register({
                slug,
                description: config.description ?? compiled.title ?? config.slug,
                config: integrationConfig satisfies OpenApiIntegrationConfig as IntegrationConfig,
                canRemove: true,
                canRefresh:
                  specInputToSourceUrl(config.spec) != null ||
                  specInputToGoogleBundle(config.spec) != null,
              });
              yield* ctx.storage.putOperations(
                config.slug,
                storedOperationsFromCompiled(config.slug, compiled),
              );
            }),
          );

          return { slug, toolCount: compiled.definitions.length };
        });

      return {
        previewSpec: (input: string | OpenApiPreviewInput) =>
          Effect.gen(function* () {
            const previewInput = typeof input === "string" ? { spec: input } : input;
            const specText = isGoogleDiscoveryUrl(previewInput.spec)
              ? yield* fetchGoogleDiscoveryDocument(previewInput.spec).pipe(
                  Effect.provide(httpClientLayer),
                  Effect.flatMap((documentText) =>
                    convertGoogleDiscoveryToOpenApi({
                      discoveryUrl: previewInput.spec,
                      documentText,
                    }),
                  ),
                  Effect.map((conversion) => conversion.specText),
                )
              : yield* resolveSpecText(previewInput.spec).pipe(Effect.provide(httpClientLayer));
            return yield* previewSpec(specText).pipe(Effect.provide(httpClientLayer));
          }),

        addSpec,

        removeSpec: (slug: string) =>
          ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.storage.removeOperations(slug);
              yield* ctx.core.integrations
                .remove(IntegrationSlug.make(slug))
                .pipe(Effect.catchTag("IntegrationRemovalNotAllowedError", () => Effect.void));
            }),
          ),

        getIntegration: (slug: string) =>
          ctx.core.integrations.get(IntegrationSlug.make(slug)).pipe(
            Effect.map((record) =>
              record
                ? ({
                    slug: record.slug,
                    description: record.description,
                    kind: record.kind,
                    canRemove: record.canRemove,
                    canRefresh: record.canRefresh,
                  } as Integration)
                : null,
            ),
          ),

        getConfig: (slug: string): Effect.Effect<OpenApiIntegrationConfig | null, StorageFailure> =>
          ctx.core.integrations
            .get(IntegrationSlug.make(slug))
            .pipe(
              Effect.map((record) =>
                record ? decodeOpenApiIntegrationConfig(record.config) : null,
              ),
            ),

        configure: (
          slug: string,
          input: OpenApiConfigureInput,
        ): Effect.Effect<readonly Authentication[], StorageFailure> =>
          ctx.transaction(
            Effect.gen(function* () {
              const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
              if (!record) return [] as readonly Authentication[];
              const current = decodeOpenApiIntegrationConfig(record.config);
              if (!current) return [] as readonly Authentication[];

              const merged =
                input.mode === "replace"
                  ? input.authenticationTemplate
                  : mergeAuthenticationTemplate(
                      current.authenticationTemplate ?? [],
                      input.authenticationTemplate,
                    );

              const next: OpenApiIntegrationConfig = {
                ...current,
                authenticationTemplate: merged,
              };

              yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
                config: next satisfies OpenApiIntegrationConfig as IntegrationConfig,
              });

              return merged;
            }),
          ),
      };
    },

    staticSources: (self: OpenApiPluginExtension) => [
      {
        id: "openapi",
        kind: "executor",
        name: "OpenAPI",
        tools: [
          tool({
            name: "previewSpec",
            description:
              "Preview an OpenAPI document before adding it as an integration. Call this first when the user provides a spec URL/blob so you can inspect servers, auth schemes, operation count, and tags before `addSpec`. Do not collect API keys or OAuth client secrets in chat; use the connections tools for those values.",
            inputSchema: PreviewSpecInputStandardSchema,
            outputSchema: PreviewSpecOutputStandardSchema,
            execute: (input: typeof PreviewSpecInputSchema.Type) =>
              self.previewSpec(input).pipe(
                Effect.map((preview) => ToolResult.ok(staticPreviewOutput(preview))),
                Effect.catchTags({
                  OpenApiParseError: ({ message }: OpenApiParseError) =>
                    Effect.succeed(openApiToolFailure("openapi_parse_failed", message)),
                  OpenApiExtractionError: ({ message }: OpenApiExtractionError) =>
                    Effect.succeed(openApiToolFailure("openapi_extraction_failed", message)),
                  OpenApiOAuthError: ({ message }: OpenApiOAuthError) =>
                    Effect.succeed(openApiToolFailure("openapi_oauth_failed", message)),
                }),
              ),
          }),
          tool({
            name: "addSpec",
            description:
              "Add an OpenAPI integration to the catalog and persist its operations as tools. Recommended flow: call `previewSpec`, choose a `slug`, declare an `authenticationTemplate` for how a credential is applied (apiKey header/query, or oauth bearer), then create a connection for that integration with the user's API key or via `oauth.start`.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add an OpenAPI integration",
            },
            inputSchema: AddSourceInputStandardSchema,
            outputSchema: AddSourceOutputStandardSchema,
            execute: (input: typeof AddSourceInputSchema.Type) =>
              self
                .addSpec({
                  spec: input.spec,
                  slug: input.slug,
                  description: input.description,
                  baseUrl: input.baseUrl,
                  headers: input.headers,
                  queryParams: input.queryParams,
                  authenticationTemplate: input.authenticationTemplate as
                    | readonly Authentication[]
                    | undefined,
                })
                .pipe(
                  Effect.map((result) =>
                    ToolResult.ok({
                      slug: String(result.slug),
                      toolCount: result.toolCount,
                    }),
                  ),
                  Effect.catchTags({
                    OpenApiParseError: ({ message }: OpenApiParseError) =>
                      Effect.succeed(openApiToolFailure("openapi_parse_failed", message)),
                    OpenApiExtractionError: ({ message }: OpenApiExtractionError) =>
                      Effect.succeed(openApiToolFailure("openapi_extraction_failed", message)),
                    OpenApiOAuthError: ({ message }: OpenApiOAuthError) =>
                      Effect.succeed(openApiToolFailure("openapi_oauth_failed", message)),
                    IntegrationAlreadyExistsError: ({ slug }: IntegrationAlreadyExistsError) =>
                      Effect.succeed(
                        openApiToolFailure(
                          "integration_already_exists",
                          `Integration ${slug} already exists; update it instead of re-adding.`,
                        ),
                      ),
                  }),
                ),
          }),
        ],
      },
    ],

    describeAuthMethods: describeOpenApiAuthMethods,
    describeIntegrationDisplay: describeOpenApiIntegrationDisplay,

    // Produce one tool per spec operation. Spec-derived, identical for every
    // connection on the integration — so `getValue` is never called here. The
    // operation bindings invokeTool needs are persisted at addSpec time; this
    // hook only shapes the per-connection ToolDefs from the catalog config.
    resolveTools: ({
      config,
    }: {
      readonly integration: Integration;
      readonly config: IntegrationConfig;
    }): Effect.Effect<ResolveToolsResult, StorageFailure> =>
      Effect.gen(function* () {
        const openApiConfig = decodeOpenApiIntegrationConfig(config);
        if (!openApiConfig) return { tools: [], definitions: {} };
        const compiled = yield* compileSpec(openApiConfig.spec).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!compiled) return { tools: [], definitions: {} };
        return {
          tools: toolDefsFromCompiled(compiled),
          definitions: compiled.hoistedDefs,
        };
      }),

    invokeTool: ({
      ctx: invokeCtx,
      toolRow,
      credential,
      args,
    }: {
      readonly ctx: PluginCtx<OpenapiStore>;
      readonly toolRow: { readonly integration: string; readonly name: string };
      readonly credential: ToolInvocationCredential;
      readonly args: unknown;
    }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? invokeCtx.httpClientLayer;
        const integration = toolRow.integration;
        const config = decodeOpenApiIntegrationConfig(credential.config);

        // Resolve the operation binding from the plugin store; fall back to
        // deriving it from the catalog spec when the store has no row (e.g. an
        // integration registered without going through addSpec).
        let binding = (yield* invokeCtx.storage.getOperation(integration, toolRow.name))?.binding;
        if (!binding && config) {
          const compiled = yield* compileSpec(config.spec).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          binding = compiled
            ? storedOperationsFromCompiled(integration, compiled).find(
                (op) => op.toolName === toolRow.name,
              )?.binding
            : undefined;
        }
        if (!binding) {
          return yield* new OpenApiExtractionError({
            message: `No OpenAPI operation found for tool "${toolRow.name}" on "${integration}"`,
          });
        }

        const headers: Record<string, string> = { ...(config?.headers ?? {}) };
        const queryParams: Record<string, string> = {
          ...(config?.queryParams ?? {}),
        };

        // Apply the auth template (D11): render the connection's resolved inputs
        // into the matching template's header/query slots (apiKey) or as a bearer
        // Authorization header (oauth). A method with two distinct inputs (e.g.
        // Datadog) renders each from its own value.
        const template = (config?.authenticationTemplate ?? []).find(
          (entry) => String(entry.slug) === String(credential.template),
        );
        if (template) {
          // Fail if ANY input the template requires is unresolved — not just the
          // primary `token` (a Datadog connection has no `token`, only its keys).
          const missing = requiredTemplateVariables(template).filter((name) => {
            const value = credential.values[name];
            return value == null || value === "";
          });
          if (missing.length > 0) {
            return openApiAuthToolFailure({
              code:
                template.type === "oauth" ? "oauth_connection_missing" : "connection_value_missing",
              message: `Connection "${credential.connection}" for "${integration}" has no resolvable credential value. Re-authenticate or update the connection.`,
              owner: credential.owner,
              integration,
              connection: String(credential.connection),
              credentialKind: template.type === "oauth" ? "oauth" : "secret",
            });
          }
          const rendered = renderAuthTemplate(template, credential.values);
          Object.assign(headers, rendered.headers);
          Object.assign(queryParams, rendered.queryParams);
        }

        const result = yield* invokeWithLayer(
          binding,
          (args ?? {}) as Record<string, unknown>,
          config?.baseUrl ?? "",
          headers,
          queryParams,
          httpClientLayer,
        );

        const ok = result.status >= 200 && result.status < 300;
        if (!ok) {
          if (result.status === 401 || result.status === 403) {
            return openApiAuthToolFailure({
              code: "connection_rejected",
              status: result.status,
              message: `Upstream rejected credentials for "${integration}" with HTTP ${result.status}. Re-authenticate or update the connection "${credential.connection}" before retrying this tool.`,
              owner: credential.owner,
              integration,
              connection: String(credential.connection),
              credentialKind: "upstream",
              credentialLabel: "Upstream authorization",
              details: result.error,
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
      }),

    resolveAnnotations: ({
      ctx: annotationsCtx,
      integration,
      toolRows,
    }: {
      readonly ctx: PluginCtx<OpenapiStore>;
      readonly integration: string;
      readonly toolRows: readonly { readonly name: string }[];
    }) =>
      Effect.gen(function* () {
        const ops = yield* annotationsCtx.storage.listOperations(String(integration));
        const byName = new Map<string, OperationBinding>();
        for (const op of ops) byName.set(op.toolName, op.binding);
        const out: Record<string, ReturnType<typeof annotationsForOperation>> = {};
        for (const row of toolRows) {
          const binding = byName.get(row.name);
          if (binding) {
            out[row.name] = annotationsForOperation(binding.method, binding.pathTemplate);
          }
        }
        return out;
      }),

    removeConnection: () => Effect.void,

    detect: ({
      ctx: detectCtx,
      url,
    }: {
      readonly ctx: PluginCtx<OpenapiStore>;
      readonly url: string;
    }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? detectCtx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed) return null;
        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (error) => error,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return null;
        if (isGoogleDiscoveryUrl(trimmed)) {
          const conversion = yield* fetchGoogleDiscoveryDocument(trimmed).pipe(
            Effect.provide(httpClientLayer),
            Effect.flatMap((documentText) =>
              convertGoogleDiscoveryToOpenApi({
                discoveryUrl: trimmed,
                documentText,
              }),
            ),
            Effect.catch(() => Effect.succeed(null)),
          );
          if (conversion) {
            return IntegrationDetectionResult.make({
              kind: "openapi",
              confidence: "high",
              endpoint: trimmed,
              name: conversion.title,
              slug:
                conversion.title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "_")
                  .replace(/^_+|_+$/g, "") || `google_${conversion.service}`,
            });
          }
        }
        const specText = yield* resolveSpecText(trimmed).pipe(
          Effect.provide(httpClientLayer),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (specText === null) return null;
        const doc = yield* parse(specText).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!doc) return null;
        const result = yield* extract(doc).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!result) return null;
        const slug = Option.getOrElse(result.title, () => "api")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_");
        const name = Option.getOrElse(result.title, () => slug);
        return IntegrationDetectionResult.make({
          kind: "openapi",
          confidence: "high",
          endpoint: trimmed,
          name,
          slug,
        });
      }),
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-openapi/api`. Hosts that
  // want the HTTP surface import the plugin from there; SDK-only consumers
  // stay on this entry and avoid the server-only deps.
});
