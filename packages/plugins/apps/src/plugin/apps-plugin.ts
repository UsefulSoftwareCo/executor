import { Data, Effect, Predicate } from "effect";
import { ToolName, ToolResult, definePlugin, type PluginCtx, type ToolDef } from "@executor-js/sdk";

import { makeInProcessAppToolExecutor, type AppToolExecutor } from "../executor/app-tool-executor";
import { publish } from "../pipeline/publish";
import { buildBridge, resolveIntegrationBindings } from "./bindings";
import { makePluginCtxAppsResolver } from "./resolver";
import { descriptorCollection, makeAppsStore, toolCollection, type AppsStore } from "./store";

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

const makeAppsExtension = (ctx: PluginCtx<AppsStore>, executor?: AppToolExecutor) => ({
  publish: (input: Parameters<typeof publish>[1]) =>
    publish({ store: ctx.storage, executor: executor ?? makeInProcessAppToolExecutor() }, input),
});

export type AppsExtension = ReturnType<typeof makeAppsExtension>;

export const makeAppsPlugin = (options?: { readonly executor?: AppToolExecutor }) =>
  definePlugin(() => ({
    id: "apps",
    packageName: "@executor-js/plugin-apps",
    pluginStorage: {
      [descriptorCollection.name]: descriptorCollection,
      [toolCollection.name]: toolCollection,
    },
    storage: ({ blobs, pluginStorage }) => makeAppsStore({ blobs, pluginStorage }),
    extension: (ctx: PluginCtx<AppsStore>) => makeAppsExtension(ctx, options?.executor),
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
