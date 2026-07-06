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
  type HealthCheckSpec,
  type Integration,
  type IntegrationConfig,
  type IntegrationRecord,
  type PluginCtx,
} from "@executor-js/sdk/core";
import { describeApiKeyAuthMethod } from "@executor-js/sdk/http-auth";
import {
  checkHealthOpenApi,
  compileOpenApiSpec,
  invokeOpenApiBackedTool,
  listHealthCheckCandidatesOpenApi,
  makeDefaultOpenapiStore,
  normalizeOpenApiAuthInputs,
  OpenApiExtractionError,
  OpenApiParseError,
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
  googleOpenApiPresets,
  googlePhotosOpenApiBundlePreset,
  googlePhotosOpenApiPresets,
  googleServiceSlug,
  type GoogleOpenApiPreset,
} from "./presets";

const GOOGLE_OAUTH2_DISCOVERY_URL = "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest";

/** The default health check for a Google bundle: prefer the lightweight
 *  OAuth2 userinfo identity call, which every new Google bundle includes.
 *  Older bundles may only have People API, so keep that fallback. */
export const defaultGoogleHealthCheck = (
  urls: readonly string[],
  definitions: readonly {
    readonly toolPath: string;
    readonly operation: { readonly method: string; readonly pathTemplate: string };
  }[],
): HealthCheckSpec | undefined => {
  const userinfoGet = definitions.find(
    (def) =>
      def.operation.method.toLowerCase() === "get" &&
      (def.toolPath === "oauth2.userinfo.get" ||
        def.operation.pathTemplate === "/oauth2/v2/userinfo"),
  );
  if (userinfoGet) {
    return {
      operation: userinfoGet.toolPath,
      identityField: "email",
    };
  }

  const hasPeopleApi = urls.some((url) => url.includes("/people/"));
  if (!hasPeopleApi) return undefined;
  const peopleGet = definitions.find(
    (def) =>
      def.operation.method.toLowerCase() === "get" &&
      (def.toolPath === "people.people.get" ||
        def.operation.pathTemplate === "/v1/{+resourceName}"),
  );
  return peopleGet
    ? {
        operation: peopleGet.toolPath,
        args: { resourceName: "people/me", personFields: "names,emailAddresses" },
        identityField: "emailAddresses.0.value",
      }
    : undefined;
};

export const GOOGLE_CUSTOM_SERVICE_ID = "custom";

export interface GooglePresetServiceConfig {
  readonly presetId: string;
  readonly slug?: string;
  readonly name?: string;
}

export interface GoogleCustomServiceConfig {
  readonly custom: {
    readonly urls: readonly string[];
    readonly slug?: string;
    readonly name: string;
    readonly description?: string;
  };
}

export type GoogleServiceConfig = GooglePresetServiceConfig | GoogleCustomServiceConfig;

export interface GoogleAddServicesInput {
  readonly services: readonly GoogleServiceConfig[];
  readonly baseUrl?: string;
}

export interface GoogleAddServicesAdded {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly toolCount: number;
}

export interface GoogleAddServicesSkipped {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly reason: "already_exists";
}

export interface GoogleAddServicesFailed {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly error: string;
}

export interface GoogleAddServicesResult {
  readonly added: readonly GoogleAddServicesAdded[];
  readonly skipped: readonly GoogleAddServicesSkipped[];
  readonly failed: readonly GoogleAddServicesFailed[];
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

const googleOpenApiPresetById: ReadonlyMap<string, GoogleOpenApiPreset> = new Map(
  googleOpenApiPresets.map((preset) => [preset.id, preset]),
);

const isGooglePresetServiceConfig = (
  service: GoogleServiceConfig,
): service is GooglePresetServiceConfig => "presetId" in service;

const googleServiceEntryId = (service: GoogleServiceConfig): string =>
  isGooglePresetServiceConfig(service) ? service.presetId : GOOGLE_CUSTOM_SERVICE_ID;

const googleServiceEntrySlug = (service: GoogleServiceConfig): IntegrationSlug =>
  isGooglePresetServiceConfig(service)
    ? IntegrationSlug.make(service.slug?.trim() || googleServiceSlug(service.presetId))
    : IntegrationSlug.make(service.custom.slug?.trim() || "google_custom");

type GoogleAddServiceOutcome = {
  readonly added: readonly GoogleAddServicesAdded[];
  readonly skipped: readonly GoogleAddServicesSkipped[];
  readonly failed: readonly GoogleAddServicesFailed[];
};

const googleAddServiceFailure = (
  service: GoogleServiceConfig,
  slug: IntegrationSlug,
  error: string,
): GoogleAddServiceOutcome => ({
  added: [],
  skipped: [],
  failed: [{ slug, presetId: googleServiceEntryId(service), error }],
});

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
  consentScopesOverride?: readonly string[],
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
      const consentScopes = consentScopesOverride ?? googlePhotosBundleConsentScopes(urls);
      return convertGoogleDiscoveryBundleToOpenApi({
        documents,
        ...(consentScopes !== undefined ? { consentScopes } : {}),
      });
    }),
  );

const uniqueUrls = (urls: readonly string[]): readonly string[] => [
  ...new Set(urls.flatMap((url) => normalizeGoogleDiscoveryUrl(url) ?? [])),
];

const googleBundleUrlsWithIdentity = (
  urls: readonly string[],
): Effect.Effect<readonly string[], OpenApiParseError> =>
  Effect.gen(function* () {
    const normalized: string[] = [];
    for (const url of urls) {
      const discoveryUrl = normalizeGoogleDiscoveryUrl(url);
      if (!discoveryUrl) {
        return yield* new OpenApiParseError({
          message:
            "Google Discovery document URL must be a supported googleapis.com HTTPS Discovery endpoint",
        });
      }
      normalized.push(discoveryUrl);
    }
    return uniqueUrls([...normalized, GOOGLE_OAUTH2_DISCOVERY_URL]);
  });

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

  const addGoogleOpenApiIntegration = (input: {
    readonly urls: readonly string[];
    readonly slug: IntegrationSlug;
    readonly name: string;
    readonly description: string;
    readonly baseUrl?: string;
    readonly consentScopes?: readonly string[];
  }) =>
    Effect.gen(function* () {
      const urls = yield* googleBundleUrlsWithIdentity(input.urls);
      const conversion = yield* fetchGoogleBundleConversion(
        urls,
        httpClientLayer,
        input.consentScopes,
      );
      const compiled = yield* compileOpenApiSpec(conversion.specText);
      const slug = input.slug;

      const existing = yield* ctx.core.integrations.get(slug);
      if (existing) {
        return yield* new IntegrationAlreadyExistsError({ slug });
      }

      const specHash = yield* sha256Hex(conversion.specText);
      const integrationConfig: GoogleIntegrationConfig = {
        specHash,
        googleDiscoveryUrls: urls,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
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
            name: input.name,
            description: input.description,
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

      // Default the health check to the light OAuth2 userinfo identity call
      // added to every new Google OpenAPI integration. Older integrations
      // without oauth2/v2 can still fall back to the People API identity
      // operation.
      const defaultHealthCheck = defaultGoogleHealthCheck(urls, compiled.definitions);
      if (defaultHealthCheck) {
        yield* ctx.core.integrations.setHealthCheck(slug, defaultHealthCheck);
      }

      return { slug, toolCount: compiled.definitions.length };
    });

  const addOneService = (service: GoogleServiceConfig, baseUrl?: string) =>
    Effect.gen(function* () {
      if (!isGooglePresetServiceConfig(service)) {
        if (service.custom.urls.length === 0) {
          return yield* new OpenApiParseError({
            message: "Custom Google service requires at least one Discovery URL",
          });
        }
        return yield* addGoogleOpenApiIntegration({
          urls: service.custom.urls,
          slug: googleServiceEntrySlug(service),
          name: service.custom.name.trim() || "Custom Google APIs",
          description: service.custom.description ?? "Custom Google APIs.",
          baseUrl,
        });
      }

      const preset = googleOpenApiPresetById.get(service.presetId);
      if (!preset?.url) {
        return yield* new OpenApiParseError({
          message: `Google service preset is not available: ${service.presetId}`,
        });
      }

      return yield* addGoogleOpenApiIntegration({
        urls: [preset.url],
        slug: IntegrationSlug.make(service.slug?.trim() || googleServiceSlug(service.presetId)),
        name: service.name?.trim() || preset.name,
        description: preset.summary,
        baseUrl,
        consentScopes: googleOAuthConsentScopesForPreset(preset.id),
      });
    });

  const addServices = (input: GoogleAddServicesInput) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(
        input.services,
        (service): Effect.Effect<GoogleAddServiceOutcome, never> => {
          const slug = googleServiceEntrySlug(service);
          const presetId = googleServiceEntryId(service);
          return addOneService(service, input.baseUrl).pipe(
            Effect.map(
              (result): GoogleAddServiceOutcome => ({
                added: [
                  {
                    slug: result.slug,
                    presetId,
                    toolCount: result.toolCount,
                  },
                ],
                skipped: [],
                failed: [],
              }),
            ),
            Effect.catchTag("IntegrationAlreadyExistsError", () =>
              Effect.succeed({
                added: [],
                skipped: [
                  {
                    slug,
                    presetId,
                    reason: "already_exists" as const,
                  },
                ],
                failed: [],
              }),
            ),
            Effect.catchTags({
              OpenApiParseError: (error: OpenApiParseError) =>
                Effect.succeed(googleAddServiceFailure(service, slug, error.message)),
              OpenApiExtractionError: (error: OpenApiExtractionError) =>
                Effect.succeed(googleAddServiceFailure(service, slug, error.message)),
            }),
            Effect.catch(() =>
              Effect.succeed(
                googleAddServiceFailure(service, slug, "Failed to add Google service"),
              ),
            ),
          );
        },
        { concurrency: 1 },
      );

      return {
        added: outcomes.flatMap((outcome) => outcome.added),
        skipped: outcomes.flatMap((outcome) => outcome.skipped),
        failed: outcomes.flatMap((outcome) => outcome.failed),
      };
    });

  const updateBundle = (rawSlug: string, input?: GoogleUpdateInput) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(rawSlug);
      const record = yield* ctx.core.integrations.get(slug);
      const current = record ? decodeGoogleIntegrationConfig(record.config) : null;
      if (!record || !current) {
        return yield* new IntegrationNotFoundError({ slug });
      }

      const urls = yield* googleBundleUrlsWithIdentity(
        input?.urls ?? current.googleDiscoveryUrls ?? [],
      );
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
    addServices,
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

  // Health checks reuse the OpenAPI backing (same store). The People API
  // identity call is auto-defaulted when present; core owns the stored spec,
  // the user adjusts it via the editor.
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
