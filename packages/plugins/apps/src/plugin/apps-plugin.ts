/* oxlint-disable executor/no-try-catch-or-throw -- boundary: plugin source config validation is converted into the extension Effect failure channel */
import { Data, Effect, Predicate, Result } from "effect";
import { ToolName, ToolResult, definePlugin, type PluginCtx, type ToolDef } from "@executor-js/sdk";

import { makeInProcessAppToolExecutor, type AppToolExecutor } from "../executor/app-tool-executor";
import type { BundleBackend } from "../pipeline/bundle";
import { publish } from "../pipeline/publish";
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
import { fetchGitHubAppSource } from "../source/github-source";
import { fetchLocalDirectoryAppSource } from "../source/local-directory-source";
import type { AppSourceSnapshot } from "../source/app-source";
import type { PublishError } from "../pipeline/publish";

const APPS_INTEGRATION = "apps";
const APPS_CONNECTION = "published";

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
  readonly baseUrl?: string;
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
  if (input.kind === "github") {
    if (!input.url) throw new AppPluginError({ message: "github source url is required" });
    return {
      kind: "github",
      url: input.url,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    };
  }
  if (!input.path) throw new AppPluginError({ message: "local-directory source path is required" });
  return { kind: "local-directory", path: input.path };
};

const fetchSource = (config: AppSourceConfig): Effect.Effect<AppSourceSnapshot, unknown> =>
  config.kind === "github" ? fetchGitHubAppSource(config) : fetchLocalDirectoryAppSource(config);

const makeAppsExtension = (
  ctx: PluginCtx<AppsStore>,
  options?: Pick<AppsPluginOptions, "executor" | "bundler" | "sourceKinds">,
) => {
  const executor = options?.executor;
  const activeExecutor = executor ?? makeInProcessAppToolExecutor();
  const activeBundler = options?.bundler;
  const sourceKinds = options?.sourceKinds ?? ["github", "local-directory"];
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
        const slug = slugify(
          input.slug ?? input.app ?? (config.kind === "github" ? config.url : config.path),
        );
        if (!slug) return yield* new AppPluginError({ message: "source slug is required" });
        const app = slugify(input.app ?? slug);
        const record: AppSourceRecord = {
          slug,
          app,
          kind: config.kind,
          config,
          status: { type: "pending" },
          updatedAt: now(),
        };
        yield* ctx.storage.putSource(record, "org");
        return record;
      }),
    deleteSource: (slug: string) =>
      ctx.storage.removeSource(slug, "org").pipe(Effect.as({ removed: true })),
    syncSource: (slug: string): Effect.Effect<SyncAppSourceResult, unknown> =>
      Effect.gen(function* () {
        const record = yield* ctx.storage.getSource(slug);
        if (!record) return yield* new AppPluginError({ message: `app source not found: ${slug}` });
        if (!sourceKinds.includes(record.config.kind)) {
          return yield* new AppPluginError({
            message: `app source kind is not enabled: ${record.config.kind}`,
          });
        }
        const fetched = yield* fetchSource(record.config).pipe(Effect.result);
        if (Result.isFailure(fetched)) {
          const error = fetched.failure;
          const diagnostic = Predicate.isTagged("PublishError")(error)
            ? publishErrorToDiagnostic(error as PublishError)
            : sourceErrorToDiagnostic(error as never);
          const failed: AppSourceRecord = {
            ...record,
            status: { type: "failed", at: now(), errors: [diagnostic] },
            updatedAt: now(),
          };
          yield* ctx.storage.putSource(failed, "org");
          return { status: "failed", tools: [], errors: [diagnostic] };
        }
        const snapshot = fetched.success;
        if (record.sourceRef === snapshot.sourceRef) {
          const tools = (yield* ctx.storage.listActiveTools())
            .filter((tool) => tool.name.startsWith(`${record.app}__`) || tool.name === record.app)
            .map((tool) => tool.name);
          const updated: AppSourceRecord = {
            ...record,
            status: { type: "up-to-date", at: now(), tools },
            updatedAt: now(),
          };
          yield* ctx.storage.putSource(updated, "org");
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
}

export const makeAppsPlugin = (options?: AppsPluginOptions) =>
  definePlugin(() => ({
    id: "apps",
    packageName: "@executor-js/plugin-apps",
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
          ? { type: "array", items: { type: "string", enum: enumValues } }
          : { type: "string", enum: enumValues };
    }
    return { inputSchema: { ...schema, properties }, outputSchema };
  });

export const appsPlugin = makeAppsPlugin();

export { APPS_INTEGRATION, APPS_CONNECTION };
