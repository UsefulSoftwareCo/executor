import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  IntegrationAlreadyExistsError,
  IntegrationDetectionResult,
  IntegrationNotFoundError,
  IntegrationSlug,
  ToolResult,
  definePlugin,
  mergeAuthTemplates,
  sha256Hex,
  tool,
  type AuthMethodDescriptor,
  type Integration,
  type IntegrationConfig,
  type IntegrationRecord,
  type PluginCtx,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { decodeOpenApiIntegrationConfig, type OpenApiIntegrationConfig } from "./config";
import { OpenApiExtractionError, OpenApiOAuthError, OpenApiParseError } from "./errors";
import { parse, resolveSpecText } from "./parse";
import { extract } from "./extract";
import {
  OAuth2AuthorizationCodeFlow,
  OAuth2Flows,
  OAuth2Preset,
  SecurityScheme,
  previewSpecText,
  type SpecPreview,
} from "./preview";
import { deriveAuthenticationTemplateFromPreview, firstBaseUrlForPreview } from "./derive-auth";
import { openApiPresets } from "./presets";
import { makeDefaultOpenapiStore, type OpenapiStore } from "./store";
import type { Authentication } from "./types";
import { normalizeOpenApiAuthInputs, type AuthenticationInput } from "./types";
import { ApiKeyAuthTemplate, describeApiKeyAuthMethod } from "@executor-js/sdk/http-auth";
import {
  checkHealthOpenApi,
  compileOpenApiSpec,
  invokeOpenApiBackedTool,
  listHealthCheckCandidatesOpenApi,
  openApiStoredOperationsFromCompiled,
  resolveOpenApiBackedAnnotations,
  resolveOpenApiBackedTools,
  validateOpenApiBackedToolArgs,
} from "./backing";
import type { InvokeOptions } from "./invoke";
import { resolveServerUrl } from "./openapi-utils";

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
  /** Display name (defaults to the spec title). */
  readonly name?: string;
  /** Agent-visible description (defaults to the spec's `info.description`,
   *  then the title). */
  readonly description?: string;
  readonly baseUrl?: string;
  /** Static headers applied to every request (no secret material). */
  readonly headers?: Record<string, string>;
  /** Static query params applied to every request. */
  readonly queryParams?: Record<string, string>;
  /** Auth methods a connection's value renders through - canonical
   *  placements or the request-shaped authoring dialect. */
  readonly authenticationTemplate?: readonly AuthenticationInput[];
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
  readonly authenticationTemplate: readonly AuthenticationInput[];
  readonly mode?: "merge" | "replace";
}

/** What changed in the tool catalog when a spec was updated in place. Tool
 *  names, not addresses - the same diff applies to every connection. */
export interface UpdateSpecResult {
  readonly slug: IntegrationSlug;
  readonly toolCount: number;
  readonly addedTools: readonly string[];
  readonly removedTools: readonly string[];
}

export interface OpenApiUpdateSpecInput {
  /** New spec source. Omit to re-fetch from the integration's stored
   *  `sourceUrl`. */
  readonly spec?: OpenApiSpecInput;
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
  /** Re-resolve the integration's spec (from its stored source URL, or the
   *  provided input) and rebuild its tools IN PLACE - connections,
   *  credentials, policies, and the curated description are untouched. */
  readonly updateSpec: (
    slug: string,
    input?: OpenApiUpdateSpecInput,
  ) => Effect.Effect<
    UpdateSpecResult,
    | OpenApiParseError
    | OpenApiExtractionError
    | OpenApiOAuthError
    | IntegrationNotFoundError
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
  resource: Schema.NullOr(Schema.String),
  refreshUrl: Schema.NullOr(Schema.String),
  scopes: Schema.Record(Schema.String, Schema.String),
  identityScopes: Schema.Union([
    Schema.Literal("auto"),
    Schema.Literal(false),
    Schema.Array(Schema.String),
  ]),
  supportsClientIdMetadataDocument: Schema.optional(Schema.Boolean),
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

const AuthenticationSchema = Schema.Union([
  Schema.Struct({
    slug: Schema.String,
    kind: Schema.Literal("oauth2"),
    authorizationUrl: Schema.String,
    tokenUrl: Schema.String,
    resource: Schema.optional(Schema.NullOr(Schema.String)),
    scopes: Schema.Array(Schema.String),
    supportsClientIdMetadataDocument: Schema.optional(Schema.Boolean),
  }),
  // Credential methods are authored request-shaped - the ONE apikey input
  // dialect: `{ type: "apiKey", headers: { Authorization: ["Bearer ",
  // variable("token")] }, queryParams: { … } }`.
  ApiKeyAuthTemplate,
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
    resource: Option.getOrNull(preset.resource),
    refreshUrl: Option.getOrNull(preset.refreshUrl),
    scopes: preset.scopes,
    identityScopes: preset.identityScopes,
    supportsClientIdMetadataDocument: preset.supportsClientIdMetadataDocument,
  })),
});

const specInputToSourceUrl = (spec: OpenApiSpecInput): string | undefined =>
  spec.kind === "url" ? spec.url : undefined;

const OAUTH_DISCOVERED_SCHEME_NAME = "DiscoveredOAuth2";
const OPENAPI_HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const maybeUrl = (value: string): URL | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL parsing accepts user-pasted spec/base URLs
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const addProbeCandidate = (candidates: string[], value: string | undefined): void => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  const parsed = maybeUrl(trimmed);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return;
  const normalized = parsed.toString();
  const origin = parsed.origin;
  if (!candidates.includes(normalized)) candidates.push(normalized);
  if (!candidates.includes(origin)) candidates.push(origin);
};

const oauthProbeCandidates = (
  preview: SpecPreview,
  sourceUrl: string | undefined,
  baseUrl: string | undefined,
): readonly string[] => {
  const candidates: string[] = [];
  addProbeCandidate(candidates, baseUrl);
  for (const server of preview.servers) {
    addProbeCandidate(
      candidates,
      resolveServerUrl(server.url, Option.getOrUndefined(server.variables), {}),
    );
  }
  addProbeCandidate(candidates, sourceUrl);
  return candidates;
};

const securityRequirementScopes = (
  security: unknown,
  targetSchemes: ReadonlySet<string>,
): readonly string[] => {
  if (!Array.isArray(security)) return [];
  const scopes = new Set<string>();
  for (const requirement of security) {
    if (!isRecord(requirement)) continue;
    for (const [scheme, rawScopes] of Object.entries(requirement)) {
      if (targetSchemes.size > 0 && !targetSchemes.has(scheme)) continue;
      if (!Array.isArray(rawScopes)) continue;
      for (const scope of rawScopes) {
        if (typeof scope === "string" && scope.trim().length > 0) scopes.add(scope.trim());
      }
    }
  }
  return [...scopes];
};

const collectDeclaredSecurityScopes = (doc: unknown, targetSchemes: ReadonlySet<string>) => {
  const scopes = new Set<string>();
  if (!isRecord(doc)) return [] as readonly string[];

  for (const scope of securityRequirementScopes(doc.security, targetSchemes)) scopes.add(scope);

  const paths = doc.paths;
  if (!isRecord(paths)) return [...scopes].sort();
  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!OPENAPI_HTTP_METHODS.has(method.toLowerCase()) || !isRecord(operation)) continue;
      for (const scope of securityRequirementScopes(operation.security, targetSchemes)) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes].sort();
};

const nonOAuthSecuritySchemeNames = (preview: SpecPreview): ReadonlySet<string> =>
  new Set(
    preview.securitySchemes
      .filter((scheme) => scheme.type === "http" || scheme.type === "apiKey")
      .map((scheme) => scheme.name),
  );

const discoveredOAuthPreview = (input: {
  readonly preview: SpecPreview;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopes: readonly string[];
  readonly supportsClientIdMetadataDocument?: boolean;
}): SpecPreview => {
  const scopes = Object.fromEntries(input.scopes.map((scope) => [scope, ""]));
  const flow = OAuth2AuthorizationCodeFlow.make({
    authorizationUrl: input.authorizationUrl,
    tokenUrl: input.tokenUrl,
    refreshUrl: Option.none(),
    scopes,
  });
  const flows = OAuth2Flows.make({
    authorizationCode: Option.some(flow),
    clientCredentials: Option.none(),
  });
  return {
    ...input.preview,
    securitySchemes: [
      ...input.preview.securitySchemes,
      SecurityScheme.make({
        name: OAUTH_DISCOVERED_SCHEME_NAME,
        type: "oauth2",
        scheme: Option.none(),
        bearerFormat: Option.none(),
        in: Option.none(),
        headerName: Option.none(),
        description: Option.some("Discovered from OAuth authorization-server metadata"),
        flows: Option.some(flows),
        openIdConnectUrl: Option.none(),
      }),
    ],
    oauth2Presets: [
      ...input.preview.oauth2Presets,
      OAuth2Preset.make({
        label: `OAuth2 Authorization Code · ${OAUTH_DISCOVERED_SCHEME_NAME}`,
        securitySchemeName: OAUTH_DISCOVERED_SCHEME_NAME,
        flow: "authorizationCode",
        authorizationUrl: Option.some(input.authorizationUrl),
        tokenUrl: input.tokenUrl,
        resource: input.resource ? Option.some(input.resource) : Option.none(),
        refreshUrl: Option.none(),
        scopes,
        identityScopes: "auto",
        ...(input.supportsClientIdMetadataDocument === true
          ? { supportsClientIdMetadataDocument: true }
          : {}),
      }),
    ],
  };
};

// ---------------------------------------------------------------------------
// Declared auth methods - project the stored `authenticationTemplate` into the
// catalog's plugin-agnostic `AuthMethodDescriptor[]`. This mirrors the client's
// `authMethodsFromConfig` (in the React auth-method-config module) on the
// server so the catalog field is consistent. apikey/none projection comes from
// the shared model; the oauth method carries the stored endpoints + scopes.
// ---------------------------------------------------------------------------

export const describeOpenApiAuthMethods = (
  record: IntegrationRecord,
): readonly AuthMethodDescriptor[] => {
  const config = decodeOpenApiIntegrationConfig(record.config);
  if (!config) return [];
  return (config.authenticationTemplate ?? []).map(
    (template: Authentication): AuthMethodDescriptor => {
      if (template.kind === "oauth2") {
        return {
          id: String(template.slug),
          label: "OAuth2",
          kind: "oauth",
          template: String(template.slug),
          oauth: {
            authorizationUrl: template.authorizationUrl,
            tokenUrl: template.tokenUrl,
            resource: template.resource ?? null,
            scopes: template.scopes,
            supportsClientIdMetadataDocument: template.supportsClientIdMetadataDocument,
          },
        };
      }
      return describeApiKeyAuthMethod(template);
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
// Plugin factory
// ---------------------------------------------------------------------------

export interface OpenApiPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
  readonly invokeOptions?: InvokeOptions;
}

export const openApiPlugin = definePlugin((options?: OpenApiPluginOptions) => {
  const resolveSpecForInput = (
    spec: OpenApiSpecInput,
    httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
  ): Effect.Effect<
    {
      readonly specText: string;
    },
    OpenApiParseError | OpenApiExtractionError | OpenApiOAuthError
  > =>
    Effect.gen(function* () {
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

      const enrichPreviewWithDiscoveredOAuth = (input: {
        readonly specText: string;
        readonly preview: SpecPreview;
        readonly sourceUrl?: string;
        readonly baseUrl?: string;
      }): Effect.Effect<SpecPreview, OpenApiParseError | OpenApiExtractionError> =>
        Effect.gen(function* () {
          if (input.preview.oauth2Presets.length > 0) return input.preview;

          const candidates = oauthProbeCandidates(input.preview, input.sourceUrl, input.baseUrl);
          if (candidates.length === 0) return input.preview;

          for (const candidate of candidates) {
            const oauth = yield* ctx.oauth.probe({ url: candidate }).pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch(() => Effect.succeed({ ok: false as const, result: null })),
            );
            if (!oauth.ok) continue;

            const doc = yield* parse(input.specText);
            const declaredScopes = collectDeclaredSecurityScopes(
              doc,
              nonOAuthSecuritySchemeNames(input.preview),
            );
            const supportedScopes =
              oauth.result.scopesSupported && oauth.result.scopesSupported.length > 0
                ? new Set(oauth.result.scopesSupported)
                : null;
            const scopes = supportedScopes
              ? declaredScopes.filter((scope) => supportedScopes.has(scope))
              : declaredScopes;
            return discoveredOAuthPreview({
              preview: input.preview,
              authorizationUrl: oauth.result.authorizationUrl,
              tokenUrl: oauth.result.tokenUrl,
              resource: oauth.result.resource ?? null,
              scopes,
              supportsClientIdMetadataDocument:
                oauth.result.clientIdMetadataDocumentSupported === true,
            });
          }

          return input.preview;
        });

      const addSpec = (config: OpenApiSpecConfig) =>
        Effect.gen(function* () {
          // Resolve URL → text and parse BEFORE opening a transaction. Holding
          // `BEGIN` across a network fetch is the Hyperdrive deadlock path.
          const resolved = yield* resolveSpecForInput(config.spec, httpClientLayer);
          const compiled = yield* compileOpenApiSpec(resolved.specText);

          // Defaults the add page derives from its preview, applied here so
          // headless callers (MCP, API) get the same integration the UI's
          // add flow would produce - see e2e/scenarios/connect-handoff.test.ts:
          //   - effectiveBaseUrl: the spec's first server, used to anchor the
          //     derived auth template's absolute URLs. It is NOT stored as the
          //     connection baseUrl - the request host is resolved per call from
          //     the operation's extracted `servers`.
          //   - authenticationTemplate: the spec's declared security schemes
          //     (else the Add-connection modal is a dead "No authentication"
          //     end with nowhere to paste a credential)
          // An explicit input always wins; for auth, an explicit EMPTY array
          // means "no auth methods" and suppresses the derivation.
          const explicitBaseUrl = config.baseUrl;
          const needsDerivedBaseUrl = explicitBaseUrl == null;
          const needsDerivedAuth = config.authenticationTemplate == null;
          const preview =
            needsDerivedBaseUrl || needsDerivedAuth
              ? yield* previewSpecText(resolved.specText).pipe(
                  Effect.flatMap((rawPreview) =>
                    enrichPreviewWithDiscoveredOAuth({
                      specText: resolved.specText,
                      preview: rawPreview,
                      sourceUrl: specInputToSourceUrl(config.spec),
                      baseUrl: config.baseUrl,
                    }),
                  ),
                )
              : undefined;
          const derivedBaseUrl =
            needsDerivedBaseUrl && preview ? firstBaseUrlForPreview(preview) : undefined;
          const effectiveBaseUrl = explicitBaseUrl ?? (derivedBaseUrl || undefined);
          const derivedAuthenticationTemplate =
            needsDerivedAuth && preview
              ? deriveAuthenticationTemplateFromPreview(preview, effectiveBaseUrl)
              : undefined;

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

          const specHash = yield* sha256Hex(resolved.specText);

          const integrationConfig: OpenApiIntegrationConfig = {
            specHash,
            ...(specInputToSourceUrl(config.spec) !== undefined
              ? { sourceUrl: specInputToSourceUrl(config.spec) }
              : {}),
            // baseUrl is an optional override only. The host is otherwise
            // resolved per call from the operation's `servers` (extracted from
            // the spec), so we never bake a derived base URL into the config.
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.queryParams ? { queryParams: config.queryParams } : {}),
            // Prefer the caller's explicit template; otherwise derive from the
            // spec's declared security schemes.
            ...(config.authenticationTemplate
              ? {
                  authenticationTemplate: normalizeOpenApiAuthInputs(config.authenticationTemplate),
                }
              : derivedAuthenticationTemplate && derivedAuthenticationTemplate.length > 0
                ? { authenticationTemplate: derivedAuthenticationTemplate }
                : {}),
          };

          // The spec blob is written OUTSIDE the transaction: it's
          // content-addressed (re-puts are idempotent) and an aborted register
          // leaves only an unreferenced blob behind - while blob backends like
          // R2 couldn't roll back with the transaction anyway.
          yield* ctx.storage.putSpec(specHash, resolved.specText);
          // The content-addressed defs blob lets the serve path resolve the
          // shared `definitions` without re-parsing the spec. Same idempotent,
          // outside-the-transaction rationale as the spec blob.
          yield* ctx.storage.putDefs(specHash, JSON.stringify(compiled.hoistedDefs));

          yield* ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.core.integrations.register({
                slug,
                name: config.name?.trim() || compiled.title || config.slug,
                description:
                  config.description ?? compiled.description ?? compiled.title ?? config.slug,
                config: integrationConfig satisfies OpenApiIntegrationConfig as IntegrationConfig,
                canRemove: true,
                canRefresh: specInputToSourceUrl(config.spec) != null,
              });
              yield* ctx.storage.putOperations(
                config.slug,
                openApiStoredOperationsFromCompiled(config.slug, compiled),
              );
            }),
          );

          return { slug, toolCount: compiled.definitions.length };
        });

      // Update the spec IN PLACE: re-resolve (stored source URL / bundle, or a
      // caller-supplied new input), recompile, swap the stored operations, and
      // rebuild every connection's tools. Auth templates, base URL, headers,
      // the curated description, connections, and policies are all untouched -
      // this is the "spec changed upstream" path, not a re-add.
      const updateSpec = (rawSlug: string, input?: OpenApiUpdateSpecInput) =>
        Effect.gen(function* () {
          const slug = IntegrationSlug.make(rawSlug);
          const record = yield* ctx.core.integrations.get(slug);
          const current = record ? decodeOpenApiIntegrationConfig(record.config) : null;
          if (!record || !current) {
            return yield* new IntegrationNotFoundError({ slug });
          }

          // The new spec source: explicit input wins; otherwise re-fetch from
          // where the spec originally came from. A pasted-blob integration has
          // no origin, so updating it requires a new input.
          const specInput: OpenApiSpecInput | null =
            input?.spec ?? (current.sourceUrl ? { kind: "url", url: current.sourceUrl } : null);
          if (specInput === null) {
            return yield* new OpenApiParseError({
              message:
                "This integration's spec was pasted inline and has no source URL to re-fetch. Provide the updated spec content.",
            });
          }

          // Resolve + compile BEFORE the transaction (same Hyperdrive-deadlock
          // rule as addSpec: never hold BEGIN across a network fetch).
          const resolved = yield* resolveSpecForInput(specInput, httpClientLayer);
          const compiled = yield* compileOpenApiSpec(resolved.specText);

          const previousOperations = yield* ctx.storage.listOperations(rawSlug);
          const previousNames = new Set(previousOperations.map((op) => op.toolName));
          const nextNames = new Set(compiled.definitions.map((def) => def.toolPath));

          // The resolved spec text lives in the plugin blob store keyed by its
          // content hash (`spec/<hash>`); the config carries only the hash. Put
          // the blob outside the transaction - re-puts are idempotent and an
          // aborted config update just leaves an unreferenced blob.
          const specHash = yield* sha256Hex(resolved.specText);
          yield* ctx.storage.putSpec(specHash, resolved.specText);
          yield* ctx.storage.putDefs(specHash, JSON.stringify(compiled.hoistedDefs));

          const nextConfig: OpenApiIntegrationConfig = {
            ...current,
            specHash,
            ...(specInputToSourceUrl(specInput) !== undefined
              ? { sourceUrl: specInputToSourceUrl(specInput) }
              : {}),
          };

          yield* ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.core.integrations.update(slug, {
                config: nextConfig satisfies OpenApiIntegrationConfig as IntegrationConfig,
              });
              yield* ctx.storage.putOperations(
                rawSlug,
                openApiStoredOperationsFromCompiled(rawSlug, compiled),
              );
            }),
          );

          // Rebuild each connection's tool rows from the new spec. Outside the
          // transaction: refresh opens its own, and a half-refreshed catalog
          // self-heals on the next refresh anyway.
          const connections = yield* ctx.connections.list({ integration: slug });
          yield* Effect.forEach(
            connections,
            (connection) =>
              ctx.connections
                .refresh({
                  owner: connection.owner,
                  integration: connection.integration,
                  name: connection.name,
                })
                .pipe(Effect.catchTag("ConnectionNotFoundError", () => Effect.succeed([]))),
            { discard: true },
          ).pipe(
            Effect.catchTag("IntegrationNotFoundError", () => Effect.void),
            Effect.withSpan("openapi.plugin.update_spec.refresh_connections", {
              attributes: { "openapi.connection_count": connections.length },
            }),
          );

          return {
            slug,
            toolCount: compiled.definitions.length,
            addedTools: [...nextNames].filter((name) => !previousNames.has(name)).sort(),
            removedTools: [...previousNames].filter((name) => !nextNames.has(name)).sort(),
          } satisfies UpdateSpecResult;
        }).pipe(
          Effect.withSpan("openapi.plugin.update_spec", {
            attributes: { "openapi.integration.slug": rawSlug },
          }),
        );

      return {
        previewSpec: (input: string | OpenApiPreviewInput) =>
          Effect.gen(function* () {
            const previewInput = typeof input === "string" ? { spec: input } : input;
            const specText = yield* resolveSpecText(previewInput.spec).pipe(
              Effect.provide(httpClientLayer),
            );
            const preview = yield* previewSpecText(specText);
            return yield* enrichPreviewWithDiscoveredOAuth({
              specText,
              preview,
              sourceUrl: maybeUrl(previewInput.spec.trim()) ? previewInput.spec.trim() : undefined,
            });
          }),

        addSpec,

        updateSpec,

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

              const incoming = normalizeOpenApiAuthInputs(input.authenticationTemplate);
              const merged =
                input.mode === "replace"
                  ? incoming
                  : mergeAuthTemplates(current.authenticationTemplate ?? [], incoming);

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
              "Add an OpenAPI integration to the catalog and persist its operations as tools. Recommended flow: call `previewSpec`, choose a `slug`, then create a connection for that integration with the user's API key or via `oauth.start`. When `baseUrl` is omitted it defaults to the spec's first server; when `authenticationTemplate` is omitted the auth methods are derived from the spec's declared security schemes (pass an explicit template to override how a credential is applied - apiKey header/query, or oauth bearer - or an empty array for no auth methods).",
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
                    | readonly AuthenticationInput[]
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

    // Health checks: the declared liveness/identity probe. Core owns the spec
    // storage; the plugin only enumerates candidates and runs probes.
    listHealthCheckCandidates: (input) =>
      listHealthCheckCandidatesOpenApi({ ctx: input.ctx, integration: input.integration }),
    checkHealth: (input) =>
      checkHealthOpenApi({
        ctx: input.ctx,
        integration: input.integration,
        credential: input.credential,
        spec: input.spec,
        httpClientLayer: options?.httpClientLayer ?? input.ctx.httpClientLayer,
      }),

    // Produce one tool per spec operation. Spec-derived, identical for every
    // connection on the integration - so `getValue` is never called here. The
    // operation bindings invokeTool needs are persisted at addSpec time; this
    // hook only shapes the per-connection ToolDefs from the spec blob the
    // catalog config points at.
    resolveTools: ({ integration, config, storage }) =>
      resolveOpenApiBackedTools({ integration, config, storage }),

    invokeTool: ({ ctx: invokeCtx, toolRow, credential, args }) => {
      const httpClientLayer = options?.httpClientLayer ?? invokeCtx.httpClientLayer;
      return invokeOpenApiBackedTool({
        ctx: invokeCtx,
        toolRow,
        credential,
        args,
        httpClientLayer,
        invokeOptions: options?.invokeOptions,
      });
    },

    validateToolArgs: ({ ctx: validateCtx, toolRow, args }) =>
      validateOpenApiBackedToolArgs({ ctx: validateCtx, toolRow, args }),

    resolveAnnotations: ({ ctx: annotationsCtx, integration, toolRows }) =>
      resolveOpenApiBackedAnnotations({
        ctx: annotationsCtx,
        integration: String(integration),
        toolRows,
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
