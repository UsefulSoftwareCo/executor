import { Effect } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  IntegrationAlreadyExistsError,
  IntegrationDetectionResult,
  IntegrationNotFoundError,
  IntegrationSlug,
  definePlugin,
  mergeAuthTemplates,
  sha256Hex,
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
  googleOAuthConsentScopesForPreset,
  googleOpenApiBundlePreset,
  googlePhotosOpenApiBundlePreset,
  googlePhotosOpenApiPresets,
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

const googlePhotosBundlePresetIdByUrl = new Map(
  googlePhotosOpenApiPresets.flatMap((preset) =>
    preset.url ? [[normalizeGoogleDiscoveryUrl(preset.url) ?? preset.url, preset.id] as const] : [],
  ),
);

const googlePhotosBundleConsentScopes = (
  urls: readonly string[],
): readonly string[] | undefined => {
  const normalized = new Set(urls);
  const presetIds = [...googlePhotosBundlePresetIdByUrl.entries()].flatMap(([url, presetId]) =>
    normalized.has(url) ? [presetId] : [],
  );
  return presetIds.length > 0
    ? presetIds.flatMap((presetId) => googleOAuthConsentScopesForPreset(presetId))
    : undefined;
};

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
  ).pipe(
    Effect.flatMap((documents) => {
      const consentScopes = googlePhotosBundleConsentScopes(urls);
      return convertGoogleDiscoveryBundleToOpenApi({
        documents,
        ...(consentScopes ? { consentScopes } : {}),
      });
    }),
  );

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

export const googlePlugin = definePlugin((options?: GooglePluginOptions) => ({
  id: "google" as const,
  packageName: "@executor-js/plugin-google",
  integrationPresets: [googleOpenApiBundlePreset, googlePhotosOpenApiBundlePreset],
  storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

  extension: (ctx: PluginCtx<OpenapiStore>) => makeGooglePluginExtension(options, ctx),

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
