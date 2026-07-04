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
  checkHealthOpenApi,
  compileAndPersistOpenApiSpecStreaming,
  listHealthCheckCandidatesOpenApi,
  decodeOpenApiIntegrationConfig,
  invokeOpenApiBackedTool,
  makeDefaultOpenapiStore,
  normalizeOpenApiAuthInputs,
  OpenApiExtractionError,
  OpenApiParseError,
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
  type MicrosoftGraphSelectionInput,
  type MicrosoftGraphUrlPolicy,
  type MicrosoftGraphIntegrationConfig,
  type MicrosoftGraphSpecBuild,
} from "./graph";
import {
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_BASE_URL,
  microsoftGraphPreset,
  microsoftGraphPresetForId,
  microsoftServiceSlug,
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

export interface MicrosoftWorkloadConfig {
  readonly presetId: string;
  readonly slug?: string;
  readonly name?: string;
}

export interface MicrosoftAddWorkloadsInput {
  readonly workloads: readonly MicrosoftWorkloadConfig[];
  readonly baseUrl?: string;
}

export interface MicrosoftAddWorkloadsAdded {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly toolCount: number;
}

export interface MicrosoftAddWorkloadsSkipped {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly reason: "already_exists";
}

export interface MicrosoftAddWorkloadsFailed {
  readonly slug: IntegrationSlug;
  readonly presetId: string;
  readonly error: string;
}

export interface MicrosoftAddWorkloadsResult {
  readonly added: readonly MicrosoftAddWorkloadsAdded[];
  readonly skipped: readonly MicrosoftAddWorkloadsSkipped[];
  readonly failed: readonly MicrosoftAddWorkloadsFailed[];
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

type MicrosoftAddWorkloadOutcome = {
  readonly added: readonly MicrosoftAddWorkloadsAdded[];
  readonly skipped: readonly MicrosoftAddWorkloadsSkipped[];
  readonly failed: readonly MicrosoftAddWorkloadsFailed[];
};

const microsoftAddWorkloadFailure = (
  workload: MicrosoftWorkloadConfig,
  slug: IntegrationSlug,
  error: string,
): MicrosoftAddWorkloadOutcome => ({
  added: [],
  skipped: [],
  failed: [{ slug, presetId: workload.presetId, error }],
});

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

  const addMicrosoftGraphIntegration = (input: {
    readonly selection: MicrosoftGraphSelectionInput;
    readonly slug: IntegrationSlug;
    readonly name: string;
    readonly description: string;
    readonly baseUrl?: string;
  }) =>
    Effect.gen(function* () {
      const graph = yield* buildMicrosoftGraphOpenApiSpec(
        input.selection,
        httpClientLayer,
        urlPolicy,
      );
      const slug = input.slug;

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
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      };

      yield* ctx.storage.putSpec(specHash, graph.specText);

      const persisted = yield* ctx.transaction(
        Effect.gen(function* () {
          yield* ctx.core.integrations.register({
            slug,
            name: input.name,
            description: input.description,
            config:
              integrationConfig satisfies MicrosoftGraphIntegrationConfig as IntegrationConfig,
            canRemove: true,
            canRefresh: true,
          });
          return yield* persistGraphOperations(graph, String(slug), specHash);
        }),
      );

      // Default the health check to `GET /me` (the canonical Graph identity
      // endpoint) when the selected workloads include it, so connections report
      // alive/expired + who-am-I out of the box. The operations were streamed
      // to storage above, so find the binding there. Best-effort: a Graph
      // selection without /me just leaves the check unconfigured (the editor
      // remains available).
      const meOperation = (yield* ctx.storage.listOperations(String(slug))).find(
        (op) => op.binding.method.toLowerCase() === "get" && op.binding.pathTemplate === "/me",
      );
      if (meOperation) {
        yield* ctx.core.integrations.setHealthCheck(slug, {
          operation: meOperation.toolName,
          identityField: "userPrincipalName",
        });
      }

      return { slug, toolCount: persisted.toolCount };
    });

  const addGraph = (config: MicrosoftGraphConfig) =>
    addMicrosoftGraphIntegration({
      selection: config,
      slug: IntegrationSlug.make(config.slug?.trim() || DEFAULT_MICROSOFT_SLUG),
      name: config.name?.trim() || "Microsoft Graph",
      description: config.description ?? "Selected Microsoft Graph workloads.",
      baseUrl: config.baseUrl,
    });

  const addOneWorkload = (workload: MicrosoftWorkloadConfig, baseUrl?: string) =>
    Effect.gen(function* () {
      const preset = microsoftGraphPresetForId(workload.presetId);
      if (!preset) {
        return yield* new OpenApiParseError({
          message: `Microsoft Graph workload preset is not available: ${workload.presetId}`,
        });
      }

      // A per-workload integration filters the Graph tree to just this one
      // preset. The bare GET /me identity keep is seeded by the shared
      // keepPathItem filter, so every workload source gets its own /me health
      // check even when the profile workload is not selected. Scopes are this
      // preset's scopes plus the identity scope (User.Read), derived by
      // `microsoftGraphScopesForPresetIds` inside the spec build.
      return yield* addMicrosoftGraphIntegration({
        selection: { presetIds: [preset.id] },
        slug: IntegrationSlug.make(workload.slug?.trim() || microsoftServiceSlug(preset.id)),
        name: workload.name?.trim() || preset.name,
        description: preset.summary,
        baseUrl,
      });
    });

  const addWorkloads = (input: MicrosoftAddWorkloadsInput) =>
    Effect.gen(function* () {
      // Strict {concurrency: 1}: parsing the 37MB Graph tree already strains the
      // 128MB Workers isolate, so two workload adds in flight recreate the OOM
      // in aggregate. Each add must fully settle before the next begins.
      const outcomes = yield* Effect.forEach(
        input.workloads,
        (workload): Effect.Effect<MicrosoftAddWorkloadOutcome, never> => {
          const slug = IntegrationSlug.make(
            workload.slug?.trim() || microsoftServiceSlug(workload.presetId),
          );
          return addOneWorkload(workload, input.baseUrl).pipe(
            Effect.map(
              (result): MicrosoftAddWorkloadOutcome => ({
                added: [
                  {
                    slug: result.slug,
                    presetId: workload.presetId,
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
                    presetId: workload.presetId,
                    reason: "already_exists" as const,
                  },
                ],
                failed: [],
              }),
            ),
            Effect.catchTags({
              OpenApiParseError: (error: OpenApiParseError) =>
                Effect.succeed(microsoftAddWorkloadFailure(workload, slug, error.message)),
              OpenApiExtractionError: (error: OpenApiExtractionError) =>
                Effect.succeed(microsoftAddWorkloadFailure(workload, slug, error.message)),
            }),
            Effect.catch(() =>
              Effect.succeed(
                microsoftAddWorkloadFailure(workload, slug, "Failed to add Microsoft workload"),
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
    addWorkloads,
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

  // Health checks reuse the OpenAPI backing (same store). GET /me is
  // auto-defaulted at addGraph when present; core owns the stored spec.
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
