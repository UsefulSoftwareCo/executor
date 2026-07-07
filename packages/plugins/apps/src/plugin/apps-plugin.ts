import { Effect, Result } from "effect";

import {
  AuthTemplateSlug,
  definePlugin,
  IntegrationDetectionResult,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  connectionIdentifier,
  tool,
  type IntegrationRecord,
  type InvokeToolInput,
  type PluginCtx,
  type ResolveToolsInput,
  type ResolveToolsResult,
  StorageError,
  type StorageFailure,
  type ToolDef,
  type IntegrationRemovalNotAllowedError,
} from "@executor-js/sdk";

import type { IntegrationDecl, ToolDescriptor } from "../pipeline/descriptor";
import { PublishError } from "../pipeline/discover";
import { ArtifactStoreError } from "../seams/artifact-store";
import { ScopeDbError } from "../seams/scope-db";
import { ToolSandboxError } from "../seams/tool-sandbox";
import {
  parseGitHubSourceUrl,
  syncGitHubSource,
  type GitHubSkippedArtifact,
  type GitHubSyncResult,
} from "../source/github-source";
import { slugifyCustomToolsAppName, validateCustomToolsAppSlug } from "../source/app-slug";
import type { AppsRuntime, GitHubCustomToolsSourceSummary } from "./runtime";
import { makeAppsStore, type AppDescriptorRecord, type GitHubSourceTokenRef } from "./store";
import { BindingError, type ClientResolver, type ConnectionCandidate } from "./bindings";
import { makePluginCtxAppsResolver } from "./resolver";
import { makeAppsRuntimeFromBackings, type AppsBackings } from "./backings";

export const APPS_INTEGRATION_SLUG = "apps";
export const APPS_PLUGIN_ID = "apps";

const APP_CONNECTION_NAME = connectionIdentifier("main");

interface AppsGitHubSourceConfig {
  readonly kind: "github";
  readonly repoUrl: string;
  readonly repo: string;
  readonly scope: string;
  readonly ref?: string;
  readonly token?: GitHubSourceTokenRef;
}

type ResolverFactory = (input: {
  readonly ctx: unknown;
  readonly scope: string;
  readonly tool: string;
}) => ClientResolver;

export type AppsPluginOptions =
  | {
      readonly backings: AppsBackings;
      readonly runtime?: never;
      readonly makeResolver?: ResolverFactory;
    }
  | {
      readonly runtime: AppsRuntime;
      readonly backings?: never;
      readonly makeResolver?: ResolverFactory;
    };

interface AppsStoreShape {
  readonly runtime: AppsRuntime;
}

export interface AppsPluginExtension {
  readonly runtime: AppsRuntime;
  readonly syncGitHubSource: (input: unknown) => Effect.Effect<GitHubSyncResult, StorageFailure>;
  readonly listGitHubSources: () => Effect.Effect<{
    readonly sources: readonly GitHubCustomToolsSourceSummary[];
  }>;
  readonly getGitHubSource: (slug: string) => Effect.Effect<{
    readonly source: GitHubCustomToolsSourceSummary | null;
  }>;
  readonly removeGitHubSource: (
    slug: string,
  ) => Effect.Effect<
    { readonly removed: true },
    StorageFailure | IntegrationRemovalNotAllowedError
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const isPluginCtx = (value: unknown): value is PluginCtx =>
  isRecord(value) &&
  isRecord(value.connections) &&
  typeof value.connections.list === "function" &&
  typeof value.connections.get === "function" &&
  typeof value.execute === "function";

const syncFailure = (message: string, path?: string): GitHubSyncResult => ({
  status: "failed",
  tools: [],
  skipped: [],
  errors: [
    {
      stage: "source",
      message,
      ...(path ? { diagnostics: [{ path, message }] } : {}),
    },
  ],
});

const missingResolver = (): ClientResolver => ({
  listConnections: () => Effect.succeed([]),
  resolveConnection: () => Effect.succeed(null),
  call: ({ integration, connection }) =>
    Effect.fail(
      new BindingError({
        role: integration,
        integration,
        requestedConnection: connection,
        message: "apps resolver is unavailable outside a request-scoped executor",
      }),
    ),
});

const missingBackingsMessage = "apps plugin requires backings or runtime";

const missingPublishError = (): PublishError =>
  new PublishError({
    message: missingBackingsMessage,
    stage: "project",
    diagnostics: [],
  });

const missingStorageError = (): StorageError =>
  new StorageError({
    message: missingBackingsMessage,
    cause: missingBackingsMessage,
  });

const missingRuntime = (): AppsRuntime => ({
  publish: () => Effect.fail(missingPublishError()),
  getDescriptor: () => Effect.succeed(null),
  listGitHubSources: () => Effect.succeed([]),
  removeSource: () => Effect.fail(missingPublishError()),
  repair: () => Effect.fail(missingPublishError()),
  invokeTool: () => Effect.fail(missingPublishError()),
  deps: {
    artifactStore: {
      forScope: () =>
        Effect.fail(
          new ArtifactStoreError({
            message: missingBackingsMessage,
          }),
        ),
      removeScope: () =>
        Effect.fail(
          new ArtifactStoreError({
            message: missingBackingsMessage,
          }),
        ),
    },
    scopeDb: {
      forScope: () =>
        Effect.fail(
          new ScopeDbError({
            message: missingBackingsMessage,
          }),
        ),
      removeScope: () =>
        Effect.fail(
          new ScopeDbError({
            message: missingBackingsMessage,
          }),
        ),
      close: () => Effect.void,
    },
    sandbox: {
      collect: () =>
        Effect.fail(
          new ToolSandboxError({
            message: missingBackingsMessage,
            kind: "collect",
          }),
        ),
      invoke: () =>
        Effect.fail(
          new ToolSandboxError({
            message: missingBackingsMessage,
            kind: "invoke",
          }),
        ),
    },
    store: {
      putDescriptor: () => Effect.fail(missingStorageError()),
      getDescriptor: () => Effect.succeed(null),
      removeDescriptor: () => Effect.fail(missingStorageError()),
      listDescriptors: () => Effect.succeed([]),
    },
    resolver: missingResolver(),
  },
});

const sourceTokenItemId = (tenant: string, scope: string): ProviderItemId =>
  ProviderItemId.make(`apps:github-source:${tenant}:${scope}:token`);

const configBaseUrl = (config: unknown): string | undefined =>
  isRecord(config) && typeof config.baseUrl === "string" && config.baseUrl.length > 0
    ? config.baseUrl
    : undefined;

const decodeSourceConfig = (config: unknown): AppsGitHubSourceConfig | null => {
  if (!isRecord(config) || config.kind !== "github") return null;
  const repoUrl = asString(config.repoUrl);
  const repo = asString(config.repo);
  const scope = asString(config.scope);
  if (!repoUrl || !repo || !scope) return null;
  const ref = asString(config.ref);
  const token = isRecord(config.token)
    ? {
        provider: asString(config.token.provider) ?? "",
        itemId: asString(config.token.itemId) ?? "",
        updatedAt: typeof config.token.updatedAt === "number" ? config.token.updatedAt : 0,
      }
    : undefined;
  return {
    kind: "github",
    repoUrl,
    repo,
    scope,
    ...(ref ? { ref } : {}),
    ...(token && token.provider && token.itemId ? { token } : {}),
  };
};

const projectInputSchema = (
  schema: unknown,
  integrations: Readonly<Record<string, IntegrationDecl>>,
  byRole: Readonly<Record<string, readonly ConnectionCandidate[]>>,
): unknown => {
  const base: Record<string, unknown> = isRecord(schema) ? { ...schema } : { type: "object" };
  const properties = isRecord(base.properties) ? { ...base.properties } : {};
  const required = new Set(
    Array.isArray(base.required)
      ? base.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  for (const [role, decl] of Object.entries(integrations)) {
    const addresses = unique((byRole[role] ?? []).map((c) => c.address));
    const roleSchema: Record<string, unknown> = {
      type: "string",
      enum: addresses,
      description: `Connection to use for ${role} (${decl.integration})`,
    };
    if (addresses.length === 1) {
      roleSchema.default = addresses[0];
      required.delete(role);
    } else {
      required.add(role);
    }
    properties[role] = roleSchema;
  }

  const projected: Record<string, unknown> = {
    ...base,
    type: typeof base.type === "string" ? base.type : "object",
    properties,
  };
  if (required.size > 0) projected.required = [...required];
  else delete projected.required;
  return projected;
};

const projectTool = (descriptor: ToolDescriptor): ToolDef => ({
  name: ToolName.make(descriptor.name),
  description: descriptor.description,
  inputSchema: descriptor.inputSchema,
  outputSchema: descriptor.outputSchema,
  annotations: {
    requiresApproval: descriptor.annotations?.destructive === true,
  },
});

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => {
  const runtime =
    options?.runtime ??
    (options?.backings
      ? makeAppsRuntimeFromBackings(options.backings, missingResolver())
      : missingRuntime());
  const makeResolver = options?.makeResolver;

  const tenantFor = (ctx: Pick<PluginCtx, "owner"> | undefined): string => {
    const tenant = ctx?.owner?.tenant;
    return tenant === undefined ? "org" : String(tenant);
  };

  const storeSourceToken = (
    ctx: PluginCtx<AppsStoreShape>,
    tenant: string,
    scope: string,
    token: string,
  ): Effect.Effect<GitHubSourceTokenRef | null> =>
    Effect.gen(function* () {
      const itemId = sourceTokenItemId(tenant, scope);
      const provider = yield* ctx.providers.setDefault(itemId, token).pipe(Effect.result);
      if (Result.isFailure(provider)) return null;
      return {
        provider: String(provider.success),
        itemId: String(itemId),
        updatedAt: Date.now(),
      };
    });

  const storedSourceToken = (
    ctx: PluginCtx<AppsStoreShape>,
    ref: GitHubSourceTokenRef | undefined,
  ): Effect.Effect<string | null> => {
    if (!ref) return Effect.succeed(null);
    return ctx.providers
      .get(ProviderKey.make(ref.provider), ProviderItemId.make(ref.itemId))
      .pipe(Effect.orElseSucceed(() => null));
  };

  const removeStoredSourceToken = (
    ctx: PluginCtx<AppsStoreShape>,
    ref: GitHubSourceTokenRef | undefined,
  ): Effect.Effect<void, unknown> =>
    ref
      ? ctx.providers.remove(ProviderKey.make(ref.provider), ProviderItemId.make(ref.itemId))
      : Effect.void;

  const ensureAppConnection = (slug: IntegrationSlug, ctx: PluginCtx<AppsStoreShape>) =>
    Effect.gen(function* () {
      const conns = yield* ctx.connections
        .list({ integration: slug })
        .pipe(Effect.orElseSucceed(() => []));
      if (!conns.some((connection) => String(connection.name) === String(APP_CONNECTION_NAME))) {
        yield* ctx.connections.create({
          owner: "user",
          name: APP_CONNECTION_NAME,
          integration: slug,
          template: AuthTemplateSlug.make("none"),
          value: "",
        });
      }
      return { owner: "user" as const, integration: slug, name: APP_CONNECTION_NAME };
    });

  const refreshAppConnection = (slug: IntegrationSlug, ctx: PluginCtx<AppsStoreShape>) =>
    Effect.gen(function* () {
      const ref = yield* ensureAppConnection(slug, ctx);
      yield* ctx.connections.refresh(ref).pipe(Effect.orElseSucceed(() => []));
      return ref;
    });

  const descriptorRecordByScope = (tenant: string) =>
    runtime.deps.store.listDescriptors(tenant).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((records) => new Map(records.map((record) => [record.descriptor.scope, record]))),
    );

  const sourceSummaryFor = (
    integration: IntegrationRecord,
    recordsByScope: ReadonlyMap<string, AppDescriptorRecord>,
  ): GitHubCustomToolsSourceSummary | null => {
    const config = decodeSourceConfig(integration.config);
    if (!config) return null;
    const record = recordsByScope.get(config.scope);
    if (!record) return null;
    const descriptor = record.descriptor;
    const source = descriptor?.source;
    if (source?.kind !== "github") return null;
    return {
      slug: String(integration.slug),
      name: integration.name,
      scope: descriptor.scope,
      url: source.url,
      repo: source.repo,
      ref: source.ref,
      hasToken: config.token !== undefined,
      upstreamSha: source.upstreamSha,
      snapshotId: descriptor.snapshotId,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      publishedAt: new Date(record.publishedAt).toISOString(),
      tools: descriptor.tools.map((toolDesc) => toolDesc.name),
      skipped: [
        ...(source.skipped ?? []),
        ...(descriptor.skipped as readonly GitHubSkippedArtifact[]),
      ],
    };
  };

  const listSources = (ctx: PluginCtx<AppsStoreShape>) =>
    Effect.gen(function* () {
      const tenant = tenantFor(ctx);
      const recordsByScope = yield* descriptorRecordByScope(tenant);
      const integrations = yield* ctx.core.integrations.list().pipe(Effect.orElseSucceed(() => []));
      const sources: GitHubCustomToolsSourceSummary[] = [];
      for (const integration of integrations) {
        if (integration.kind !== APPS_PLUGIN_ID) continue;
        const record = yield* ctx.core.integrations
          .get(integration.slug)
          .pipe(Effect.orElseSucceed(() => null));
        if (!record) continue;
        const summary = sourceSummaryFor(record, recordsByScope);
        if (summary) sources.push(summary);
      }
      return sources.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    });

  const getSource = (ctx: PluginCtx<AppsStoreShape>, slug: string) =>
    Effect.gen(function* () {
      const tenant = tenantFor(ctx);
      const recordsByScope = yield* descriptorRecordByScope(tenant);
      const record = yield* ctx.core.integrations
        .get(IntegrationSlug.make(slug))
        .pipe(Effect.orElseSucceed(() => null));
      return record && record.kind === APPS_PLUGIN_ID
        ? sourceSummaryFor(record, recordsByScope)
        : null;
    });

  const syncExistingSource = (
    ctx: PluginCtx<AppsStoreShape>,
    slugValue: string,
    providedToken: string | null,
  ) =>
    Effect.gen(function* () {
      const slug = IntegrationSlug.make(slugValue);
      const record = yield* ctx.core.integrations.get(slug).pipe(Effect.orElseSucceed(() => null));
      const config = record?.kind === APPS_PLUGIN_ID ? decodeSourceConfig(record.config) : null;
      if (!record || !config) {
        return syncFailure(`Custom tools source "${slugValue}" does not exist.`);
      }
      const github = yield* ctx.core.integrations
        .get(IntegrationSlug.make("github"))
        .pipe(Effect.orElseSucceed(() => null));
      const tenant = tenantFor(ctx);
      const token = providedToken ?? (yield* storedSourceToken(ctx, config.token));
      const result = yield* syncGitHubSource({
        runtime,
        tenant,
        scope: config.scope,
        url: config.repoUrl,
        ...(config.ref ? { ref: config.ref } : {}),
        token,
        baseUrl: configBaseUrl(github?.config),
      });
      if (result.status === "failed") return result;

      const tokenRef = providedToken
        ? yield* storeSourceToken(ctx, tenant, config.scope, providedToken)
        : config.token;
      if (providedToken && !tokenRef) {
        return syncFailure(
          "No writable credential provider is available to store the GitHub source token.",
        );
      }
      const descriptor = yield* runtime.getDescriptor(tenant, config.scope);
      const source = descriptor?.source?.kind === "github" ? descriptor.source : null;
      const nextConfig: AppsGitHubSourceConfig = {
        ...config,
        ...(source
          ? {
              repoUrl: source.url,
              repo: source.repo,
              ref: source.ref,
            }
          : {}),
        ...(tokenRef ? { token: tokenRef } : {}),
      };
      yield* ctx.core.integrations.update(slug, {
        ...(descriptor?.description ? { description: descriptor.description } : {}),
        config: nextConfig,
      });
      yield* refreshAppConnection(slug, ctx);
      return result;
    });

  const addSource = (
    ctx: PluginCtx<AppsStoreShape>,
    input: {
      readonly url: string;
      readonly ref?: string;
      readonly name?: string;
      readonly token: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const parsed = parseGitHubSourceUrl(input.url, { ref: input.ref });
      if (!parsed.ok) return syncFailure(parsed.message, input.url);
      const rawName = input.name && input.name.trim().length > 0 ? input.name : parsed.value.name;
      const slugValue = slugifyCustomToolsAppName(rawName);
      const slugError = validateCustomToolsAppSlug(slugValue);
      if (slugError) return syncFailure(slugError);
      const slug = IntegrationSlug.make(slugValue);
      const existing = yield* ctx.core.integrations
        .get(slug)
        .pipe(Effect.orElseSucceed(() => null));
      if (existing) {
        return syncFailure(`Integration "${slugValue}" already exists. Choose another name.`);
      }

      const github = yield* ctx.core.integrations
        .get(IntegrationSlug.make("github"))
        .pipe(Effect.orElseSucceed(() => null));
      const tenant = tenantFor(ctx);
      const scope = slugValue;
      const result = yield* syncGitHubSource({
        runtime,
        tenant,
        scope,
        url: input.url,
        ...(input.ref ? { ref: input.ref } : {}),
        token: input.token,
        baseUrl: configBaseUrl(github?.config),
      });
      if (result.status === "failed") return result;

      const tokenRef = input.token
        ? yield* storeSourceToken(ctx, tenant, scope, input.token)
        : undefined;
      if (input.token && !tokenRef) {
        yield* runtime.removeSource({ tenant, scope }).pipe(Effect.orElseSucceed(() => undefined));
        return syncFailure(
          "No writable credential provider is available to store the GitHub source token.",
        );
      }

      const descriptor = yield* runtime.getDescriptor(tenant, scope);
      const source = descriptor?.source?.kind === "github" ? descriptor.source : null;
      const config: AppsGitHubSourceConfig = {
        kind: "github",
        repoUrl: source?.url ?? input.url.trim(),
        repo: source?.repo ?? parsed.value.repo,
        scope,
        ...(source?.ref ? { ref: source.ref } : input.ref ? { ref: input.ref } : {}),
        ...(tokenRef ? { token: tokenRef } : {}),
      };
      yield* ctx.core.integrations.register({
        slug,
        name: slugValue,
        description:
          descriptor?.description ??
          `Custom tools synced from ${source?.repo ?? parsed.value.repo}.`,
        config,
        canRemove: true,
        canRefresh: false,
      });
      yield* refreshAppConnection(slug, ctx);
      return result;
    });

  const configForToolRow = (
    ctx: PluginCtx<AppsStoreShape>,
    integration: IntegrationSlug,
  ): Effect.Effect<AppsGitHubSourceConfig | null> =>
    ctx.core.integrations.get(integration).pipe(
      Effect.map((record) =>
        record && record.kind === APPS_PLUGIN_ID ? decodeSourceConfig(record.config) : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const requestResolver = (input: {
    readonly ctx: unknown;
    readonly scope: string;
    readonly tool: string;
  }): ClientResolver =>
    makeResolver
      ? makeResolver(input)
      : isPluginCtx(input.ctx)
        ? makePluginCtxAppsResolver({ ctx: input.ctx })
        : runtime.deps.resolver;

  const syncSourceFromPayload = (ctx: PluginCtx<AppsStoreShape>, args: unknown) =>
    Effect.gen(function* () {
      const payload = isRecord(args) ? args : {};
      const url =
        typeof payload.url === "string"
          ? payload.url.trim()
          : typeof payload.repo === "string"
            ? payload.repo.trim()
            : "";
      const ref = asString(payload.ref);
      const providedToken = asString(payload.token) ?? null;
      const slug = asString(payload.slug);
      if (slug && !url) return yield* syncExistingSource(ctx, slug, providedToken);
      if (!url) return syncFailure('sync_github_source requires "url"');
      return yield* addSource(ctx, {
        url,
        ...(ref ? { ref } : {}),
        ...(asString(payload.name) ? { name: asString(payload.name) } : {}),
        token: providedToken,
      });
    }).pipe(
      Effect.catchTags({
        CredentialProviderNotRegisteredError: (err) => Effect.succeed(syncFailure(err.message)),
        IntegrationNotFoundError: (err) => Effect.succeed(syncFailure(err.message)),
        InvalidConnectionInputError: (err) => Effect.succeed(syncFailure(err.message)),
      }),
    );

  const extensionFor = (ctx: PluginCtx<AppsStoreShape>): AppsPluginExtension => ({
    runtime,
    syncGitHubSource: (input) => syncSourceFromPayload(ctx, input),
    listGitHubSources: () =>
      Effect.gen(function* () {
        const sources = yield* listSources(ctx);
        return { sources };
      }),
    getGitHubSource: (slug) =>
      Effect.gen(function* () {
        if (!slug) return { source: null };
        const source = yield* getSource(ctx, slug);
        return { source };
      }),
    removeGitHubSource: (slug) =>
      Effect.gen(function* () {
        yield* ctx.core.integrations.remove(IntegrationSlug.make(slug));
        return { removed: true as const };
      }),
  });

  return {
    id: APPS_PLUGIN_ID as "apps",
    packageName: "@executor-js/plugin-apps",

    storage: (deps): AppsStoreShape => {
      void makeAppsStore({
        pluginStorage: deps.pluginStorage,
      });
      return { runtime };
    },

    pluginStorage: {
      published_descriptor: {
        name: "published_descriptor",
        schema: { Type: {} as Record<string, unknown> },
        indexes: [],
      },
    },

    extension: extensionFor,

    staticSources: (self) => [
      {
        id: APPS_PLUGIN_ID,
        kind: "executor",
        name: "Apps",
        tools: [
          tool<AppsStoreShape>({
            name: "sync_github_source",
            description: "Sync a GitHub repository containing custom tool source files.",
            execute: (args) => self.syncGitHubSource(args),
          }),
          tool<AppsStoreShape>({
            name: "list_github_sources",
            description: "List synced GitHub repositories that publish custom tools.",
            execute: () => self.listGitHubSources(),
          }),
          tool<AppsStoreShape>({
            name: "get_github_source",
            description: "Read one synced GitHub custom-tools source.",
            execute: (args) =>
              self.getGitHubSource(isRecord(args) ? (asString(args.slug) ?? "") : ""),
          }),
        ],
      },
    ],

    removeIntegration: ({ ctx, integration }) =>
      Effect.gen(function* () {
        const config = decodeSourceConfig(integration.config);
        if (!config) return;
        yield* removeStoredSourceToken(ctx, config.token);
        yield* runtime.removeSource({ tenant: tenantFor(ctx), scope: config.scope });
      }),

    describeIntegrationDisplay: (integration) => {
      const config = decodeSourceConfig(integration.config);
      return config ? { url: config.repoUrl } : {};
    },

    detect: ({ url }) =>
      Effect.sync(() => {
        const parsed = parseGitHubSourceUrl(url);
        if (!parsed.ok) return null;
        return IntegrationDetectionResult.make({
          kind: APPS_PLUGIN_ID,
          confidence: "high",
          endpoint: parsed.value.url,
          name: `Add custom tools from ${parsed.value.repo}`,
          slug: slugifyCustomToolsAppName(parsed.value.name),
        });
      }),

    resolveTools: ({ ctx, config }: ResolveToolsInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const source = decodeSourceConfig(config);
        if (!source) return { tools: [] } satisfies ResolveToolsResult;
        const tenant = ctx ? tenantFor(ctx) : "org";
        const descriptor = yield* runtime.getDescriptor(tenant, source.scope);
        if (!descriptor) return { tools: [] } satisfies ResolveToolsResult;
        const tools: ToolDef[] = [];
        for (const t of descriptor.tools) {
          tools.push(projectTool(t));
        }
        return { tools } satisfies ResolveToolsResult;
      }),

    projectToolSchema: ({ ctx, toolRow, inputSchema, outputSchema }) =>
      Effect.gen(function* () {
        const tenant = tenantFor(ctx);
        const source = yield* configForToolRow(ctx, IntegrationSlug.make(toolRow.integration));
        if (!source) return { inputSchema, outputSchema };
        const descriptor = yield* runtime.getDescriptor(tenant, source.scope);
        const toolDesc = descriptor?.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) return { inputSchema, outputSchema };
        const resolver = requestResolver({ ctx, scope: source.scope, tool: toolRow.name });
        const byRole: Record<string, readonly ConnectionCandidate[]> = {};
        for (const [role, decl] of Object.entries(toolDesc.integrations)) {
          byRole[role] = yield* resolver
            .listConnections({ integration: decl.integration })
            .pipe(Effect.orElseSucceed(() => []));
        }
        return {
          inputSchema: projectInputSchema(toolDesc.inputSchema, toolDesc.integrations, byRole),
          outputSchema: toolDesc.outputSchema,
        };
      }),

    invokeTool: ({ ctx, toolRow, args, invokeOptions }: InvokeToolInput<AppsStoreShape>) =>
      Effect.gen(function* () {
        const tenant = tenantFor(ctx);
        const source = yield* configForToolRow(ctx, IntegrationSlug.make(toolRow.integration));
        if (!source) {
          return yield* new PublishError({
            message: `apps integration "${toolRow.integration}" has no custom-tools source config`,
            stage: "project",
            diagnostics: [],
          });
        }
        const descriptor = yield* runtime.getDescriptor(tenant, source.scope);
        if (!descriptor) {
          return yield* new PublishError({
            message: `apps scope "${source.scope}" has no published app`,
            stage: "project",
            diagnostics: [],
          });
        }
        const toolDesc = descriptor.tools.find((t) => t.name === toolRow.name);
        if (!toolDesc) {
          return yield* new PublishError({
            message: `apps tool "${toolRow.name}" is not published in scope "${source.scope}"`,
            stage: "project",
            diagnostics: [],
          });
        }
        const resolver = requestResolver({ ctx, scope: source.scope, tool: toolRow.name });
        return yield* runtime.invokeTool({
          tenant,
          scope: source.scope,
          tool: toolRow.name,
          args,
          resolver,
          invokeOptions,
        });
      }),
  };
});
