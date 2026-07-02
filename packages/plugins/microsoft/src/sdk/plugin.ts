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
  type StorageFailure,
} from "@executor-js/sdk/core";
import { describeApiKeyAuthMethod } from "@executor-js/sdk/http-auth";
import {
  compileAndPersistOpenApiSpecStreaming,
  decodeOpenApiIntegrationConfig,
  invokeOpenApiBackedTool,
  makeDefaultOpenapiStore,
  normalizeOpenApiAuthInputs,
  OpenApiExtractionError,
  resolveOpenApiBackedAnnotations,
  resolveOpenApiBackedTools,
  type Authentication,
  type AuthenticationInput,
  type OpenApiPersistResult,
  type OpenapiStore,
} from "@executor-js/plugin-openapi";

import {
  buildMicrosoftGraphOpenApiSpec,
  decodeMicrosoftGraphIntegrationConfig,
  microsoftGraphKeepPathItem,
  type MicrosoftGraphUrlPolicy,
  type MicrosoftGraphIntegrationConfig,
  type MicrosoftGraphSpecBuild,
} from "./graph";
import {
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_BASE_URL,
  microsoftGraphPreset,
} from "./presets";

export interface MicrosoftGraphConfig {
  readonly presetIds?: readonly string[];
  readonly customScopes?: readonly string[];
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly baseUrl?: string;
  readonly specUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly clientCredentialsTokenUrl?: string;
}

export interface MicrosoftConfigureInput {
  readonly authenticationTemplate: readonly AuthenticationInput[];
  readonly mode?: "merge" | "replace";
}

export interface MicrosoftUpdateInput {
  readonly presetIds?: readonly string[];
  readonly customScopes?: readonly string[];
  readonly baseUrl?: string;
  readonly specUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly clientCredentialsTokenUrl?: string;
}

export interface MicrosoftUpdateResult {
  readonly slug: IntegrationSlug;
  readonly toolCount: number;
  readonly addedTools: readonly string[];
  readonly removedTools: readonly string[];
}

export interface MicrosoftPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient, never, never>;
  /**
   * Allows `addGraph` to point spec/base/OAuth URLs at a trusted https host
   * other than the pinned Microsoft Graph endpoints, or at plain http on
   * loopback (local Graph emulators). Off by default; hosts wire this to
   * their own local-network dev posture (e.g. `allowLocalNetwork`), never on
   * in production.
   */
  readonly allowUnsafeUrlOverrides?: boolean;
}

const DEFAULT_MICROSOFT_SLUG = "microsoft_graph";

const describeMicrosoftAuthMethods = (
  record: IntegrationRecord,
): readonly AuthMethodDescriptor[] => {
  const config = decodeOpenApiIntegrationConfig(record.config);
  if (!config) return [];
  return (config.authenticationTemplate ?? []).map(
    (template: Authentication): AuthMethodDescriptor => {
      if (template.kind === "oauth2") {
        const machineFlow =
          String(template.slug) === MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG;
        return {
          id: String(template.slug),
          label: machineFlow ? "Microsoft OAuth (client credentials)" : "Microsoft OAuth",
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

const describeMicrosoftIntegrationDisplay = (
  record: IntegrationRecord,
): { readonly url?: string } => {
  const config = decodeMicrosoftGraphIntegrationConfig(record.config);
  return { url: config?.baseUrl ?? MICROSOFT_GRAPH_BASE_URL };
};

const makeMicrosoftPluginExtension = (
  ctx: PluginCtx<OpenapiStore>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
  urlPolicy?: MicrosoftGraphUrlPolicy,
) => {
  const persistGraphOperations = (
    graph: MicrosoftGraphSpecBuild,
    integration: string,
    specHash: string,
  ): Effect.Effect<OpenApiPersistResult, OpenApiExtractionError | StorageFailure> =>
    // Stream the (full 37MB) source straight to persisted bindings + a
    // content-addressed defs blob, never materializing the whole-document tree
    // that OOMs the 128MB Workers isolate. `keepPathItem` applies the Microsoft
    // Graph scope selection per path-item during the stream; a full-graph
    // selection returns `undefined` (keep everything).
    compileAndPersistOpenApiSpecStreaming({
      specText: graph.specText,
      integration,
      storage: ctx.storage,
      specHash,
      keepPathItem: microsoftGraphKeepPathItem(graph),
    });

  const addGraph = (config: MicrosoftGraphConfig) =>
    Effect.gen(function* () {
      const graph = yield* buildMicrosoftGraphOpenApiSpec(config, httpClientLayer, urlPolicy);
      const slug = IntegrationSlug.make(config.slug?.trim() || DEFAULT_MICROSOFT_SLUG);

      const existing = yield* ctx.core.integrations.get(slug);
      if (existing) {
        return yield* new IntegrationAlreadyExistsError({ slug });
      }

      const specHash = yield* sha256Hex(graph.specText);
      const integrationConfig: MicrosoftGraphIntegrationConfig = {
        specHash,
        sourceUrl: graph.specUrl,
        microsoftGraphPresetIds: graph.presetIds,
        microsoftGraphCustomScopes: graph.customScopes,
        microsoftGraphScopes: graph.scopes,
        microsoftGraphExactPaths: graph.exactPaths,
        microsoftGraphPathPrefixes: graph.pathPrefixes,
        microsoftGraphTagPrefixes: graph.tagPrefixes,
        microsoftGraphCoversFullGraph: graph.coversFullGraph,
        microsoftGraphAuthorizationUrl: graph.authorizationUrl,
        microsoftGraphTokenUrl: graph.tokenUrl,
        microsoftGraphClientCredentialsTokenUrl: graph.clientCredentialsTokenUrl,
        authenticationTemplate: graph.authenticationTemplate,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      };

      yield* ctx.storage.putSpec(specHash, graph.specText);

      const persisted = yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.integrations.register({
            slug,
            name: config.name?.trim() || "Microsoft Graph",
            description: config.description ?? "Selected Microsoft Graph workloads.",
            config:
              integrationConfig satisfies MicrosoftGraphIntegrationConfig as IntegrationConfig,
            canRemove: true,
            canRefresh: true,
          });
          return yield* persistGraphOperations(graph, String(slug), specHash);
        }),
      );

      return { slug, toolCount: persisted.toolCount };
    });

  const updateGraph = (rawSlug: string, input?: MicrosoftUpdateInput) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(rawSlug);
      const record = yield* ctx.core.integrations.get(slug);
      const current = record ? decodeMicrosoftGraphIntegrationConfig(record.config) : null;
      if (!record || !current) {
        return yield* new IntegrationNotFoundError({ slug });
      }

      const graph = yield* buildMicrosoftGraphOpenApiSpec(
        {
          presetIds: input?.presetIds ?? current.microsoftGraphPresetIds,
          customScopes: input?.customScopes ?? current.microsoftGraphCustomScopes,
          baseUrl: input?.baseUrl ?? current.baseUrl,
          specUrl: input?.specUrl ?? current.sourceUrl,
          authorizationUrl: input?.authorizationUrl ?? current.microsoftGraphAuthorizationUrl,
          tokenUrl: input?.tokenUrl ?? current.microsoftGraphTokenUrl,
          clientCredentialsTokenUrl:
            input?.clientCredentialsTokenUrl ?? current.microsoftGraphClientCredentialsTokenUrl,
        },
        httpClientLayer,
        urlPolicy,
      );
      const previousOperations = yield* ctx.storage.listOperations(rawSlug);
      const previousNames = new Set(previousOperations.map((op) => op.toolName));

      const specHash = yield* sha256Hex(graph.specText);
      yield* ctx.storage.putSpec(specHash, graph.specText);

      const nextConfig: MicrosoftGraphIntegrationConfig = {
        ...current,
        specHash,
        sourceUrl: graph.specUrl,
        microsoftGraphPresetIds: graph.presetIds,
        microsoftGraphCustomScopes: graph.customScopes,
        microsoftGraphScopes: graph.scopes,
        microsoftGraphExactPaths: graph.exactPaths,
        microsoftGraphPathPrefixes: graph.pathPrefixes,
        microsoftGraphTagPrefixes: graph.tagPrefixes,
        microsoftGraphCoversFullGraph: graph.coversFullGraph,
        microsoftGraphAuthorizationUrl: graph.authorizationUrl,
        microsoftGraphTokenUrl: graph.tokenUrl,
        microsoftGraphClientCredentialsTokenUrl: graph.clientCredentialsTokenUrl,
        authenticationTemplate: graph.authenticationTemplate,
        ...(input?.baseUrl ? { baseUrl: input.baseUrl } : {}),
      };

      const persisted = yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.integrations.update(slug, {
            config: nextConfig satisfies MicrosoftGraphIntegrationConfig as IntegrationConfig,
          });
          return yield* persistGraphOperations(graph, rawSlug, specHash);
        }),
      );
      const nextNames = new Set(persisted.toolNames);

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
        toolCount: persisted.toolCount,
        addedTools: [...nextNames].filter((name) => !previousNames.has(name)).sort(),
        removedTools: [...previousNames].filter((name) => !nextNames.has(name)).sort(),
      };
    });

  return {
    addGraph,
    updateGraph,
    removeGraph: (slug: string) =>
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
          Effect.map((record) =>
            record ? decodeMicrosoftGraphIntegrationConfig(record.config) : null,
          ),
        ),
    configure: (slug: string, input: MicrosoftConfigureInput) =>
      ctx.transaction(
        Effect.gen(function* () {
          const record = yield* ctx.core.integrations.get(IntegrationSlug.make(slug));
          if (!record) return [] as readonly Authentication[];
          const current = decodeMicrosoftGraphIntegrationConfig(record.config);
          if (!current) return [] as readonly Authentication[];

          const incoming = normalizeOpenApiAuthInputs(input.authenticationTemplate);
          const merged =
            input.mode === "replace"
              ? incoming
              : mergeAuthTemplates(current.authenticationTemplate ?? [], incoming);

          const next: MicrosoftGraphIntegrationConfig = {
            ...current,
            authenticationTemplate: merged,
          };

          yield* ctx.core.integrations.update(IntegrationSlug.make(slug), {
            config: next satisfies MicrosoftGraphIntegrationConfig as IntegrationConfig,
          });

          return merged;
        }),
      ),
  };
};

export type MicrosoftPluginExtension = ReturnType<typeof makeMicrosoftPluginExtension>;

export const microsoftPlugin = definePlugin((options?: MicrosoftPluginOptions) => ({
  id: "microsoft" as const,
  packageName: "@executor-js/plugin-microsoft",
  integrationPresets: [microsoftGraphPreset],
  storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

  extension: (ctx) =>
    makeMicrosoftPluginExtension(ctx, options?.httpClientLayer ?? ctx.httpClientLayer, {
      allowUnsafeUrlOverrides: options?.allowUnsafeUrlOverrides === true,
    }),

  describeAuthMethods: describeMicrosoftAuthMethods,
  describeIntegrationDisplay: describeMicrosoftIntegrationDisplay,

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

  detect: ({ url }) =>
    Effect.sync(() => {
      const trimmed = url.trim();
      if (!URL.canParse(trimmed)) return null;
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const isGraph =
        host === "graph.microsoft.com" ||
        (host === "learn.microsoft.com" && parsed.pathname.startsWith("/graph/")) ||
        (host === "raw.githubusercontent.com" &&
          parsed.pathname.includes("/microsoftgraph/msgraph-metadata/"));
      if (!isGraph) return null;
      return IntegrationDetectionResult.make({
        kind: "microsoft",
        confidence: "high",
        endpoint: trimmed,
        name: "Microsoft Graph",
        slug: DEFAULT_MICROSOFT_SLUG,
      });
    }),
}));
