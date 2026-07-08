/* oxlint-disable executor/no-try-catch-or-throw -- boundary: plugin source config validation is converted into the extension Effect failure channel */
import { Data, Effect, Predicate, Result } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
  ToolResult,
  definePlugin,
  type PluginCtx,
  type ToolDef,
} from "@executor-js/sdk";

import { makeInProcessAppToolExecutor, type AppToolExecutor } from "../executor/app-tool-executor";
import type { BundleBackend } from "../pipeline/bundle";
import { PUBLISH_LIMITS, publish } from "../pipeline/publish";
import { buildBridge, resolveIntegrationBindings } from "./bindings";
import { makePluginCtxAppsResolver } from "./resolver";
import {
  descriptorCollection,
  makeAppsStore,
  sourceCollection,
  toolCollection,
  type AppSourceConfig,
  type AppSourceRecord,
  type AppsStore,
} from "./store";
import {
  publishErrorToDiagnostic,
  sourceErrorToDiagnostic,
  type SyncDiagnostic,
} from "../source/app-source";
import { checkGitAppSourceRefs, fetchGitAppSource, parseGitSourceUrl } from "../source/git-source";
import { fetchLocalDirectoryAppSource } from "../source/local-directory-source";
import { AppSourceError, type AppSourceSnapshot } from "../source/app-source";
import type { PublishError } from "../pipeline/publish";

const APPS_INTEGRATION = IntegrationSlug.make("apps");
const APPS_CONNECTION = ConnectionName.make("published");
const APPS_NO_AUTH = AuthTemplateSlug.make("none");

class AppPluginError extends Data.TaggedError("AppPluginError")<{
  readonly message: string;
}> {}

interface ProjectedToolSchema {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

const innerToolError = (
  cause: unknown,
): { readonly address: string; readonly innerMessage: string; readonly code?: string } | null => {
  const direct =
    Predicate.isTagged("AppInnerToolError")(cause) && typeof cause === "object" && cause !== null
      ? (cause as {
          readonly address?: unknown;
          readonly innerMessage?: unknown;
          readonly code?: unknown;
        })
      : null;
  const nested =
    direct === null &&
    cause !== null &&
    typeof cause === "object" &&
    "cause" in cause &&
    Predicate.isTagged("AppInnerToolError")(cause.cause)
      ? (cause.cause as {
          readonly address?: unknown;
          readonly innerMessage?: unknown;
          readonly code?: unknown;
        })
      : direct;
  if (
    nested === null ||
    typeof nested.address !== "string" ||
    typeof nested.innerMessage !== "string"
  ) {
    return null;
  }
  return {
    address: nested.address,
    innerMessage: nested.innerMessage,
    ...(typeof nested.code === "string" ? { code: nested.code } : {}),
  };
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export interface CreateAppSourceInput {
  readonly slug?: string;
  readonly app?: string;
  readonly kind: AppSourceConfig["kind"];
  readonly url?: string;
  readonly ref?: string;
  readonly token?: string;
  readonly path?: string;
}

export type SyncAppSourceResult =
  | {
      readonly status: "published";
      readonly sourceRef: string;
      readonly tools: readonly string[];
      readonly errors?: undefined;
    }
  | {
      readonly status: "up-to-date";
      readonly sourceRef: string;
      readonly tools: readonly string[];
      readonly errors?: undefined;
    }
  | {
      readonly status: "failed";
      readonly sourceRef?: string;
      readonly tools: readonly string[];
      readonly errors: readonly SyncDiagnostic[];
    };

const sourceConfig = (input: CreateAppSourceInput): AppSourceConfig => {
  if (input.kind === "git") {
    if (!input.url) throw new AppPluginError({ message: "git source url is required" });
    return {
      kind: "git",
      url: input.url,
      ...(input.ref ? { ref: input.ref } : {}),
    };
  }
  if (!input.path) throw new AppPluginError({ message: "local-directory source path is required" });
  return { kind: "local-directory", path: input.path };
};

const ensureAppsCatalogConnection = (ctx: PluginCtx<AppsStore>): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* ctx.core.integrations.register({
      slug: APPS_INTEGRATION,
      name: "Apps",
      description: "Published app tools",
      config: {},
    });
    const existing = yield* ctx.connections.get({
      owner: "org",
      integration: APPS_INTEGRATION,
      name: APPS_CONNECTION,
    });
    if (existing) {
      yield* ctx.connections.refresh({
        owner: "org",
        integration: APPS_INTEGRATION,
        name: APPS_CONNECTION,
      });
      return;
    }
    yield* ctx.connections.create({
      owner: "org",
      integration: APPS_INTEGRATION,
      name: APPS_CONNECTION,
      template: APPS_NO_AUTH,
      values: {},
    });
  });

const tokenItemId = (slug: string): ProviderItemId =>
  ProviderItemId.make(`apps/source-tokens/${slug}`);

const gitHubConnectionToken = (ctx: PluginCtx<AppsStore>): Effect.Effect<string | null, unknown> =>
  Effect.gen(function* () {
    const connections = yield* ctx.connections.list({
      integration: IntegrationSlug.make("github"),
    });
    const connection = connections.find((item) => item.owner === "user") ?? connections[0];
    if (!connection) return null;
    return yield* ctx.connections.resolveValue({
      owner: connection.owner,
      integration: connection.integration,
      name: connection.name,
    });
  });

const gitTokenFor = (
  ctx: PluginCtx<AppsStore>,
  config: Extract<AppSourceConfig, { readonly kind: "git" }>,
): Effect.Effect<string | null, unknown> =>
  Effect.gen(function* () {
    if (config.tokenProvider && config.tokenItemId) {
      return yield* ctx.providers.get(
        ProviderKey.make(config.tokenProvider),
        ProviderItemId.make(config.tokenItemId),
      );
    }
    const url = yield* parseGitSourceUrl(config.url).pipe(Effect.result);
    if (Result.isFailure(url) || url.success.hostname.toLowerCase() !== "github.com") return null;
    return yield* gitHubConnectionToken(ctx);
  });

const activeToolNamesFor = (
  ctx: PluginCtx<AppsStore>,
  app: string,
): Effect.Effect<readonly string[], unknown> =>
  ctx.storage
    .listActiveTools()
    .pipe(Effect.map((tools) => tools.filter((tool) => tool.app === app).map((tool) => tool.name)));

const makeAppsExtension = (
  ctx: PluginCtx<AppsStore>,
  options?: Pick<
    AppsPluginOptions,
    "executor" | "bundler" | "sourceKinds" | "allowPrivateGitHosts"
  >,
) => {
  const executor = options?.executor;
  const activeExecutor = executor ?? makeInProcessAppToolExecutor();
  const activeBundler = options?.bundler;
  const sourceKinds = options?.sourceKinds ?? ["git", "local-directory"];
  const now = () => Date.now();
  return {
    publish: (input: Parameters<typeof publish>[1]) =>
      publish({ store: ctx.storage, executor: activeExecutor, bundler: activeBundler }, input),
    listSources: () => ctx.storage.listSources(),
    getSource: (slug: string) => ctx.storage.getSource(slug),
    createSource: (input: CreateAppSourceInput) =>
      Effect.gen(function* () {
        const config = sourceConfig(input);
        if (!sourceKinds.includes(config.kind)) {
          return yield* new AppPluginError({
            message: `app source kind is not enabled: ${config.kind}`,
          });
        }
        if (config.kind === "git") {
          yield* parseGitSourceUrl(config.url, {
            allowPrivateHosts: options?.allowPrivateGitHosts === true,
          }).pipe(
            Effect.mapError(
              () =>
                new AppPluginError({
                  message: "git source URL is not valid",
                }),
            ),
          );
        }
        const slug = slugify(
          input.slug ?? input.app ?? (config.kind === "git" ? config.url : config.path),
        );
        if (!slug) return yield* new AppPluginError({ message: "source slug is required" });
        const app = slugify(input.app ?? slug);
        const storedConfig =
          config.kind === "git" && input.token
            ? {
                ...config,
                tokenProvider: String(
                  yield* ctx.providers.setDefault(tokenItemId(slug), input.token),
                ),
                tokenItemId: String(tokenItemId(slug)),
              }
            : config;
        const record: AppSourceRecord = {
          slug,
          app,
          kind: storedConfig.kind,
          config: storedConfig,
          status: { type: "pending" },
          updatedAt: now(),
        };
        yield* ctx.storage.putSource(record, "org");
        return record;
      }),
    deleteSource: (slug: string) =>
      Effect.gen(function* () {
        const record = yield* ctx.storage.getSource(slug);
        if (record) {
          yield* ctx.storage.removePublished(record.app, "org");
          yield* ctx.connections.markToolsStale({
            owner: "org",
            integration: APPS_INTEGRATION,
            name: APPS_CONNECTION,
          });
        }
        if (
          record?.config.kind === "git" &&
          record.config.tokenProvider &&
          record.config.tokenItemId
        ) {
          yield* ctx.providers.remove(
            ProviderKey.make(record.config.tokenProvider),
            ProviderItemId.make(record.config.tokenItemId),
          );
        }
        yield* ctx.storage.removeSource(slug, "org");
        return { removed: true };
      }),
    syncSource: (slug: string): Effect.Effect<SyncAppSourceResult, unknown> =>
      Effect.gen(function* () {
        const record = yield* ctx.storage.getSource(slug);
        if (!record) return yield* new AppPluginError({ message: `app source not found: ${slug}` });
        if (!sourceKinds.includes(record.config.kind)) {
          return yield* new AppPluginError({
            message: `app source kind is not enabled: ${record.config.kind}`,
          });
        }
        const gitToken =
          record.config.kind === "git" ? yield* gitTokenFor(ctx, record.config) : null;
        if (record.config.kind === "git") {
          const checked = yield* checkGitAppSourceRefs({
            url: record.config.url,
            ...(record.config.ref ? { ref: record.config.ref } : {}),
            ...(gitToken ? { token: gitToken } : {}),
            allowPrivateHosts: options?.allowPrivateGitHosts === true,
          }).pipe(Effect.result);
          if (Result.isFailure(checked)) {
            const diagnostic = sourceErrorToDiagnostic(checked.failure);
            const failed: AppSourceRecord = {
              ...record,
              status: { type: "failed", at: now(), errors: [diagnostic] },
              updatedAt: now(),
            };
            yield* ctx.storage.putSource(failed, "org");
            return { status: "failed", tools: [], errors: [diagnostic] };
          }
          if (record.sourceRef === checked.success.sourceRef) {
            const tools = yield* activeToolNamesFor(ctx, record.app);
            const updated: AppSourceRecord = {
              ...record,
              status: { type: "up-to-date", at: now(), tools },
              updatedAt: now(),
            };
            yield* ctx.storage.putSource(updated, "org");
            yield* ensureAppsCatalogConnection(ctx);
            return { status: "up-to-date", sourceRef: checked.success.sourceRef, tools };
          }
        }
        let fetched: Result.Result<AppSourceSnapshot, AppSourceError | PublishError>;
        if (record.config.kind === "git") {
          fetched = yield* fetchGitAppSource({
            url: record.config.url,
            ...(record.config.ref ? { ref: record.config.ref } : {}),
            ...(gitToken ? { token: gitToken } : {}),
            maxBytes: PUBLISH_LIMITS.maxTotalBytes,
            allowPrivateHosts: options?.allowPrivateGitHosts === true,
          }).pipe(Effect.result);
        } else {
          fetched = yield* fetchLocalDirectoryAppSource(record.config).pipe(Effect.result);
        }
        if (Result.isFailure(fetched)) {
          const error = fetched.failure;
          const diagnostic = Predicate.isTagged("PublishError")(error)
            ? publishErrorToDiagnostic(error as PublishError)
            : sourceErrorToDiagnostic(error as AppSourceError);
          const failed: AppSourceRecord = {
            ...record,
            status: { type: "failed", at: now(), errors: [diagnostic] },
            updatedAt: now(),
          };
          yield* ctx.storage.putSource(failed, "org");
          return { status: "failed", tools: [], errors: [diagnostic] };
        }
        const snapshot: AppSourceSnapshot = fetched.success;
        if (record.sourceRef === snapshot.sourceRef) {
          const tools = yield* activeToolNamesFor(ctx, record.app);
          const updated: AppSourceRecord = {
            ...record,
            status: { type: "up-to-date", at: now(), tools },
            updatedAt: now(),
          };
          yield* ctx.storage.putSource(updated, "org");
          yield* ensureAppsCatalogConnection(ctx);
          return { status: "up-to-date", sourceRef: snapshot.sourceRef, tools };
        }
        const published = yield* publish(
          { store: ctx.storage, executor: activeExecutor, bundler: activeBundler },
          {
            app: record.app,
            files: snapshot.files,
            sourceRef: snapshot.sourceRef,
          },
        ).pipe(Effect.result);
        if (Result.isFailure(published)) {
          const diagnostic = publishErrorToDiagnostic(published.failure);
          yield* ctx.storage.putSource(
            {
              ...record,
              sourceRef: snapshot.sourceRef,
              description: snapshot.description,
              status: { type: "failed", at: now(), errors: [diagnostic] },
              updatedAt: now(),
            },
            "org",
          );
          return {
            status: "failed",
            sourceRef: snapshot.sourceRef,
            tools: [],
            errors: [diagnostic],
          };
        }
        yield* ctx.storage.putSource(
          {
            ...record,
            sourceRef: snapshot.sourceRef,
            description: snapshot.description,
            status: {
              type: published.success.noop ? "up-to-date" : "published",
              at: now(),
              tools: published.success.descriptor.tools.map((tool) => tool.name),
            },
            updatedAt: now(),
          },
          "org",
        );
        yield* ensureAppsCatalogConnection(ctx);
        return {
          status: published.success.noop ? "up-to-date" : "published",
          sourceRef: snapshot.sourceRef,
          tools: published.success.descriptor.tools.map((tool) => tool.name),
        };
      }),
  };
};

export type AppsExtension = ReturnType<typeof makeAppsExtension>;

export interface AppsPluginOptions {
  readonly executor?: AppToolExecutor;
  readonly bundler?: BundleBackend;
  readonly sourceKinds?: readonly AppSourceConfig["kind"][];
  readonly allowPrivateGitHosts?: boolean;
}

export const makeAppsPlugin = (options?: AppsPluginOptions) =>
  definePlugin(() => ({
    id: "apps",
    packageName: "@executor-js/plugin-apps",
    clientConfig: { sourceKinds: options?.sourceKinds ?? ["git", "local-directory"] },
    pluginStorage: {
      [descriptorCollection.name]: descriptorCollection,
      [toolCollection.name]: toolCollection,
      [sourceCollection.name]: sourceCollection,
    },
    storage: ({ blobs, pluginStorage }) => makeAppsStore({ blobs, pluginStorage }),
    extension: (ctx: PluginCtx<AppsStore>) => makeAppsExtension(ctx, options),
    staticSources: () => [
      {
        id: "apps",
        kind: "apps",
        name: "Apps",
        canRemove: false,
        canRefresh: false,
        tools: [],
      },
    ],
    resolveTools: ({ storage }) =>
      storage.listActiveTools().pipe(
        Effect.map((tools) => ({
          tools: tools.map(
            (tool): ToolDef => ({
              name: ToolName.make(tool.name),
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: {
                ...(tool.annotations?.requiresApproval !== undefined
                  ? { requiresApproval: tool.annotations.requiresApproval }
                  : {}),
                ...(tool.annotations?.readOnly === true ? { requiresApproval: false } : {}),
              },
            }),
          ),
        })),
      ),
    projectToolSchema: ({ ctx, toolRow, inputSchema, outputSchema }) =>
      projectAppsToolSchema(ctx, String(toolRow.name), inputSchema, outputSchema),
    validateToolArgs: ({ ctx, toolRow, args }) =>
      Effect.gen(function* () {
        const tool = yield* ctx.storage.getTool(String(toolRow.name));
        if (!tool) return;
        const resolver = makePluginCtxAppsResolver({ ctx });
        yield* resolveIntegrationBindings(tool.integrations, args, resolver);
      }),
    invokeTool: ({ ctx, toolRow, args, invokeOptions }) =>
      Effect.gen(function* () {
        const tool = yield* ctx.storage.getTool(String(toolRow.name));
        if (!tool) {
          return yield* new AppPluginError({ message: `app tool not found: ${toolRow.name}` });
        }
        const bundle = yield* ctx.storage.getBlob(tool.bundleKey);
        if (!bundle) {
          return yield* new AppPluginError({ message: `app tool bundle missing: ${tool.name}` });
        }
        const resolver = makePluginCtxAppsResolver({ ctx });
        const bindings = yield* resolveIntegrationBindings(tool.integrations, args, resolver);
        const bridge = buildBridge({
          declared: tool.integrations,
          bindings: bindings.bindings,
          resolver,
          invokeOptions,
        });
        const result = yield* (options?.executor ?? makeInProcessAppToolExecutor())
          .invoke(
            bundle,
            { toolName: tool.name },
            { ...bindings.input, ...bindings.bindings },
            bridge,
            { timeoutMs: 30_000 },
          )
          .pipe(
            Effect.catch((cause: unknown) => {
              const inner = innerToolError(cause);
              return inner
                ? Effect.succeed(
                    ToolResult.fail({
                      code: inner.code ?? "inner_tool_error",
                      message: `Inner tool ${inner.address} failed: "${inner.innerMessage}"`,
                    }),
                  )
                : Effect.fail(cause);
            }),
          );
        return "output" in result ? result.output : result;
      }),
  }))();

export const projectAppsToolSchema = (
  ctx: PluginCtx<AppsStore>,
  toolName: string,
  inputSchema: unknown,
  outputSchema: unknown,
): Effect.Effect<ProjectedToolSchema, unknown> =>
  Effect.gen(function* () {
    const tool = yield* ctx.storage.getTool(toolName);
    if (!tool || !inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      return { inputSchema, outputSchema };
    }
    const schema = inputSchema as Record<string, unknown>;
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? { ...(schema.properties as Record<string, unknown>) }
        : {};
    for (const [field, decl] of Object.entries(tool.integrations)) {
      const connections = yield* ctx.connections.list({ integration: decl.slug as never });
      const enumValues = connections.map((connection) => String(connection.address));
      properties[field] =
        decl.mode === "many"
          ? {
              type: "array",
              items: { type: "string", enum: enumValues },
              default: enumValues,
            }
          : {
              type: "string",
              enum: enumValues,
              ...(enumValues[0] ? { default: enumValues[0] } : {}),
            };
    }
    const projectedFields = new Set(Object.keys(tool.integrations));
    const required = Array.isArray(schema.required)
      ? schema.required.filter((field) => !projectedFields.has(String(field)))
      : undefined;
    return {
      inputSchema: {
        ...schema,
        properties,
        ...(required && required.length > 0 ? { required } : { required: undefined }),
      },
      outputSchema,
    };
  });

export const appsPlugin = makeAppsPlugin();

export { APPS_INTEGRATION, APPS_CONNECTION };
