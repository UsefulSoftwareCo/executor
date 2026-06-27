import { Effect, Schema } from "effect";
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
} from "@executor-js/sdk/core";
import { describeApiKeyAuthMethod } from "@executor-js/sdk/http-auth";
import {
  compileOpenApiSpec,
  invokeOpenApiBackedTool,
  makeDefaultOpenapiStore,
  normalizeOpenApiAuthInputs,
  openApiStoredOperationsFromCompiled,
  resolveOpenApiBackedAnnotations,
  resolveOpenApiBackedTools,
  OpenApiParseError,
  type Authentication,
  type AuthenticationInput,
  type OpenapiStore,
} from "@executor-js/plugin-openapi";

import {
  convertGoogleDiscoveryBundleToOpenApi,
  fetchGoogleDiscoveryDocument,
  normalizeGoogleDiscoveryUrl,
} from "./discovery";
import { decodeGoogleIntegrationConfig, type GoogleIntegrationConfig } from "./config";
import {
  googleAudienceWarningMessagesForUrls,
  googleOAuthConsentScopesForPreset,
  googleOpenApiBundlePreset,
  googleOpenApiPresetById,
  googleOpenApiPresets,
  googlePresetForDiscoveryUrl,
} from "./presets";

export interface GoogleBundleConfig {
  readonly urls: readonly string[];
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly baseUrl?: string;
}

export interface GoogleConfigureInput {
  readonly authenticationTemplate: readonly AuthenticationInput[];
  readonly mode?: "merge" | "replace";
}

export interface GoogleUpdateInput {
  readonly urls?: readonly string[];
}

export interface GoogleUpdateResult {
  readonly slug: IntegrationSlug;
  readonly toolCount: number;
  readonly addedTools: readonly string[];
  readonly removedTools: readonly string[];
}

export interface GooglePluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
}

const DEFAULT_GOOGLE_SLUG = "google";

const fetchGoogleBundleConversion = (
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

const uniqueUrls = (urls: readonly string[]): readonly string[] => [
  ...new Set(urls.flatMap((url) => normalizeGoogleDiscoveryUrl(url) ?? [])),
];

const describeGoogleAuthMethods = (record: IntegrationRecord): readonly AuthMethodDescriptor[] => {
  const config = decodeGoogleIntegrationConfig(record.config);
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
            scopes: template.scopes,
          },
        };
      }
      return describeApiKeyAuthMethod(template);
    },
  );
};

const describeGoogleIntegrationDisplay = (record: IntegrationRecord): { readonly url?: string } => {
  const config = decodeGoogleIntegrationConfig(record.config);
  return { url: config?.baseUrl ?? config?.googleDiscoveryUrls?.[0] };
};

const makeGooglePluginExtension = (
  options: GooglePluginOptions | undefined,
  ctx: PluginCtx<OpenapiStore>,
) => {
  const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;

  const addBundle = (config: GoogleBundleConfig) =>
    Effect.gen(function* () {
      const urls = uniqueUrls(config.urls);
      const conversion = yield* fetchGoogleBundleConversion(urls, httpClientLayer);
      const compiled = yield* compileOpenApiSpec(conversion.specText);
      const slug = IntegrationSlug.make(config.slug?.trim() || DEFAULT_GOOGLE_SLUG);

      const existing = yield* ctx.core.integrations.get(slug);
      if (existing) {
        return yield* new IntegrationAlreadyExistsError({ slug });
      }

      const specHash = yield* sha256Hex(conversion.specText);
      const integrationConfig: GoogleIntegrationConfig = {
        specHash,
        googleDiscoveryUrls: urls,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(conversion.authenticationTemplate
          ? { authenticationTemplate: conversion.authenticationTemplate }
          : {}),
      };

      yield* ctx.storage.putSpec(specHash, conversion.specText);
      yield* ctx.storage.putDefs(specHash, JSON.stringify(compiled.hoistedDefs));

      yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.integrations.register({
            slug,
            name: config.name?.trim() || "Google",
            description: config.description ?? "Google APIs",
            config: integrationConfig satisfies GoogleIntegrationConfig as IntegrationConfig,
            canRemove: true,
            canRefresh: true,
          });
          yield* ctx.storage.putOperations(
            String(slug),
            openApiStoredOperationsFromCompiled(String(slug), compiled),
          );
        }),
      );

      return { slug, toolCount: compiled.definitions.length };
    });

  const updateBundle = (rawSlug: string, input?: GoogleUpdateInput) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(rawSlug);
      const record = yield* ctx.core.integrations.get(slug);
      const current = record ? decodeGoogleIntegrationConfig(record.config) : null;
      if (!record || !current) {
        return yield* new IntegrationNotFoundError({ slug });
      }

      const urls = uniqueUrls(input?.urls ?? current.googleDiscoveryUrls ?? []);
      const conversion = yield* fetchGoogleBundleConversion(urls, httpClientLayer);
      const compiled = yield* compileOpenApiSpec(conversion.specText);

      const previousOperations = yield* ctx.storage.listOperations(rawSlug);
      const previousNames = new Set(previousOperations.map((op) => op.toolName));
      const nextNames = new Set(compiled.definitions.map((def) => def.toolPath));

      const specHash = yield* sha256Hex(conversion.specText);
      yield* ctx.storage.putSpec(specHash, conversion.specText);
      yield* ctx.storage.putDefs(specHash, JSON.stringify(compiled.hoistedDefs));

      const nextConfig: GoogleIntegrationConfig = {
        ...current,
        specHash,
        googleDiscoveryUrls: urls,
      };

      yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.integrations.update(slug, {
            config: nextConfig satisfies GoogleIntegrationConfig as IntegrationConfig,
          });
          yield* ctx.storage.putOperations(
            rawSlug,
            openApiStoredOperationsFromCompiled(rawSlug, compiled),
          );
        }),
      );

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
      ).pipe(Effect.catchTag("IntegrationNotFoundError", () => Effect.void));

      return {
        slug,
        toolCount: compiled.definitions.length,
        addedTools: [...nextNames].filter((name) => !previousNames.has(name)).sort(),
        removedTools: [...previousNames].filter((name) => !nextNames.has(name)).sort(),
      };
    });

  return {
    addBundle,
    updateBundle,
    removeBundle: (slug: string) =>
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
    getConfig: (slug: string) =>
      ctx.core.integrations
        .get(IntegrationSlug.make(slug))
        .pipe(
          Effect.map((record) => (record ? decodeGoogleIntegrationConfig(record.config) : null)),
        ),
    configure: (slug: string, input: GoogleConfigureInput) =>
      ctx.transaction(
        Effect.gen(function* () {
          const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
          if (!record) return [] as readonly Authentication[];
          const current = decodeGoogleIntegrationConfig(record.config);
          if (!current) return [] as readonly Authentication[];

          const incoming = normalizeOpenApiAuthInputs(input.authenticationTemplate);
          const merged =
            input.mode === "replace"
              ? incoming
              : mergeAuthTemplates(current.authenticationTemplate ?? [], incoming);

          const next: GoogleIntegrationConfig = {
            ...current,
            authenticationTemplate: merged,
          };

          yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
            config: next satisfies GoogleIntegrationConfig as IntegrationConfig,
          });

          return merged;
        }),
      ),
  };
};

export type GooglePluginExtension = ReturnType<typeof makeGooglePluginExtension>;

// ---------------------------------------------------------------------------
// Agent-facing setup tools.
//
// These mirror the web Add-Google flow (product picker, bundle, connect) so an
// agent configuring Google by conversation gets the same guided experience:
// pick products by name, bundle them in one call, and receive the exact OAuth
// next steps. Secret entry (the Google Cloud Client ID / Client Secret) still
// happens in the web UI via the oauth.clients handoff: Google has no dynamic
// client registration, so the user must bring their own Google Cloud OAuth
// client, and the secret never crosses the agent.
// ---------------------------------------------------------------------------

const GoogleProductSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  discoveryUrl: Schema.optional(Schema.String),
  oauthAudience: Schema.String,
  consentScopes: Schema.Array(Schema.String),
  recommended: Schema.Boolean,
  needsSpecialConsent: Schema.Boolean,
});

const ListProductsOutput = Schema.Struct({ products: Schema.Array(GoogleProductSchema) });

const AddBundleToolInput = Schema.Struct({
  productIds: Schema.optional(Schema.Array(Schema.String)),
  customDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const AddBundleToolOutput = Schema.Struct({
  slug: Schema.String,
  toolCount: Schema.Number,
  products: Schema.Array(Schema.String),
  audienceWarnings: Schema.Array(Schema.String),
  nextSteps: Schema.String,
});

const SetupStatusInput = Schema.Struct({ slug: Schema.optional(Schema.String) });

const SetupStatusOutput = Schema.Struct({
  configured: Schema.Boolean,
  slug: Schema.String,
  products: Schema.Array(Schema.String),
  discoveryUrls: Schema.Array(Schema.String),
  audienceWarnings: Schema.Array(Schema.String),
  nextSteps: Schema.String,
});

const ListProductsOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(ListProductsOutput),
);
const AddBundleToolInputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(AddBundleToolInput),
);
const AddBundleToolOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(AddBundleToolOutput),
);
const SetupStatusInputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SetupStatusInput),
);
const SetupStatusOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SetupStatusOutput),
);

const googleToolFailure = (code: string, message: string) => ToolResult.fail({ code, message });

const needsSpecialConsent = (audience: string): boolean =>
  audience === "workspace-admin" || audience === "unsupported-user";

// The connect step is identical for any Google bundle, so phrase it once. Google
// has no DCR, so the user brings a Google Cloud OAuth client; the secret is
// entered in the web UI through the handoff, never in chat.
const googleConnectInstructions = (slug: string): string =>
  `Integration "${slug}" is registered. To connect an account, Google requires your own Google Cloud OAuth client (Google does not support automatic / dynamic client registration). ` +
  `1) Call oauth.clients.createHandoff for integration "${slug}", then ask the user to open the returned URL and enter their Google Cloud OAuth Client ID and Client Secret in the Executor web UI. Never ask for the client secret in chat. ` +
  `2) After they save it, call oauth.clients.list to find the new client slug, then oauth.start for "${slug}" to begin Google consent and return the authorization URL for the user to approve.`;

const googleSetupTools = (self: GooglePluginExtension) => [
  tool({
    name: "listProducts",
    description:
      "List the Google APIs (Gmail, Calendar, Drive, …) that can be bundled into one Google integration. Call this first when a user wants to set up Google, then pass the chosen ids to `addBundle`. `recommended` marks the defaults the web picker pre-selects; `needsSpecialConsent` flags products that require a Workspace admin account or that Google does not grant through standard user consent.",
    outputSchema: ListProductsOutputStd,
    execute: () =>
      Effect.succeed(
        ToolResult.ok({
          products: googleOpenApiPresets.map((preset) => ({
            id: preset.id,
            name: preset.name,
            summary: preset.summary,
            ...(preset.url ? { discoveryUrl: preset.url } : {}),
            oauthAudience: preset.oauthAudience,
            consentScopes: googleOAuthConsentScopesForPreset(preset.id),
            recommended: preset.featured === true,
            needsSpecialConsent: needsSpecialConsent(preset.oauthAudience),
          })),
        }),
      ),
  }),
  tool({
    name: "addBundle",
    description:
      "Register a Google integration from chosen product ids (see `listProducts`), the same one-call bundling the web Add-Google flow does. Pass `productIds` and/or raw `customDiscoveryUrls`. Returns the integration slug, tool count, any consent warnings for the selected APIs, and the exact OAuth next steps. This only registers the integration; connecting an account (Google Cloud OAuth client + consent) is a separate step described in `nextSteps`.",
    annotations: {
      requiresApproval: true,
      approvalDescription: "Add a Google integration",
    },
    inputSchema: AddBundleToolInputStd,
    outputSchema: AddBundleToolOutputStd,
    execute: (input: typeof AddBundleToolInput.Type) =>
      Effect.gen(function* () {
        const productIds = input.productIds ?? [];
        const unknownIds: string[] = [];
        const presetUrls: string[] = [];
        for (const id of productIds) {
          const url = googleOpenApiPresetById(id)?.url;
          if (url) presetUrls.push(url);
          else unknownIds.push(id);
        }
        if (unknownIds.length > 0) {
          return googleToolFailure(
            "unknown_product",
            `Unknown Google product id(s): ${unknownIds.join(", ")}. Call listProducts to see valid ids.`,
          );
        }

        const urls = [...new Set([...presetUrls, ...(input.customDiscoveryUrls ?? [])])];
        if (urls.length === 0) {
          return googleToolFailure(
            "no_products_selected",
            "Pass at least one productId (see listProducts) or a customDiscoveryUrls entry.",
          );
        }

        return yield* self
          .addBundle({
            urls,
            slug: input.slug,
            name: input.name,
            description: input.description,
          })
          .pipe(
            Effect.map((result) =>
              ToolResult.ok({
                slug: String(result.slug),
                toolCount: result.toolCount,
                products: productIds,
                audienceWarnings: googleAudienceWarningMessagesForUrls(urls),
                nextSteps: googleConnectInstructions(String(result.slug)),
              }),
            ),
            Effect.catchTags({
              OpenApiParseError: ({ message }: OpenApiParseError) =>
                Effect.succeed(googleToolFailure("google_discovery_failed", message)),
              IntegrationAlreadyExistsError: ({ slug }: IntegrationAlreadyExistsError) =>
                Effect.succeed(
                  googleToolFailure(
                    "integration_already_exists",
                    `Integration ${slug} already exists; update it instead of re-adding.`,
                  ),
                ),
            }),
          );
      }),
  }),
  tool({
    name: "setupStatus",
    description:
      "Report where a Google integration is in setup: whether it is registered, which products it bundles, any consent warnings, and the next step to take. Use this to resume or verify an in-progress Google setup.",
    inputSchema: SetupStatusInputStd,
    outputSchema: SetupStatusOutputStd,
    execute: (input: typeof SetupStatusInput.Type) =>
      Effect.gen(function* () {
        const slug = input.slug?.trim() || DEFAULT_GOOGLE_SLUG;
        const config = yield* self.getConfig(slug);
        if (!config) {
          return ToolResult.ok({
            configured: false,
            slug,
            products: [],
            discoveryUrls: [],
            audienceWarnings: [],
            nextSteps: `No Google integration "${slug}" yet. Call listProducts to see what is available, then addBundle with the productIds you want.`,
          });
        }
        const urls = config.googleDiscoveryUrls ?? [];
        return ToolResult.ok({
          configured: true,
          slug,
          products: urls.map((url) => googlePresetForDiscoveryUrl(url)?.id ?? url),
          discoveryUrls: [...urls],
          audienceWarnings: googleAudienceWarningMessagesForUrls(urls),
          nextSteps: googleConnectInstructions(slug),
        });
      }),
  }),
];

export const googlePlugin = definePlugin((options?: GooglePluginOptions) => ({
  id: "google" as const,
  packageName: "@executor-js/plugin-google",
  integrationPresets: [googleOpenApiBundlePreset],
  storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

  extension: (ctx: PluginCtx<OpenapiStore>) => makeGooglePluginExtension(options, ctx),

  staticSources: (self) => [
    {
      id: "google",
      kind: "executor",
      name: "Google",
      tools: googleSetupTools(self),
    },
  ],

  describeAuthMethods: describeGoogleAuthMethods,
  describeIntegrationDisplay: describeGoogleIntegrationDisplay,

  resolveTools: ({ integration, config, storage }) =>
    resolveOpenApiBackedTools({ integration, config, storage }),

  invokeTool: ({ ctx, toolRow, credential, args }) => {
    const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
    return invokeOpenApiBackedTool({
      ctx,
      toolRow,
      credential,
      args,
      httpClientLayer,
    });
  },

  resolveAnnotations: ({ ctx, integration, toolRows }) =>
    resolveOpenApiBackedAnnotations({
      ctx,
      integration: String(integration),
      toolRows,
    }),

  removeConnection: () => Effect.void,

  detect: ({ ctx, url }) =>
    Effect.gen(function* () {
      const trimmed = url.trim();
      const discoveryUrl = normalizeGoogleDiscoveryUrl(trimmed);
      if (!trimmed || !discoveryUrl) return null;
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
      const conversion = yield* fetchGoogleDiscoveryDocument(discoveryUrl).pipe(
        Effect.provide(httpClientLayer),
        Effect.flatMap((documentText) =>
          convertGoogleDiscoveryBundleToOpenApi({
            documents: [{ discoveryUrl, documentText }],
          }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!conversion) return null;
      return IntegrationDetectionResult.make({
        kind: "google",
        confidence: "high",
        endpoint: discoveryUrl,
        name: conversion.title,
        slug: DEFAULT_GOOGLE_SLUG,
      });
    }),
}));
