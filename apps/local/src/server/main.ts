import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Context, Effect, Layer, ManagedRuntime } from "effect";

import { observabilityMiddleware } from "@executor-js/api";
import {
  CoreHandlers,
  ExecutorService,
  ExecutionEngineService,
  composePluginApi,
  composePluginHandlers,
} from "@executor-js/api/server";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { getExecutorBundle } from "./executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";
import { ErrorCaptureLive } from "./observability";

// ---------------------------------------------------------------------------
// Local server API.
//
// Every plugin contributes its `HttpApiGroup` and handler `Layer` through
// the spec (`routes()` / `handlers(self)` on `PluginSpec`); the host folds
// the group list into a single `HttpApi` and merges the handler layers
// into the runtime. The plugin set is the union of `executor.config.ts`
// (static, typed) and `executor.jsonc#plugins` (dynamic, jiti-loaded),
// so `LocalApi` can't be constructed until the executor bundle resolves
// — composition happens inside `createServerHandlers` instead of at
// module-eval time.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Server handlers
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: McpRequestHandler;
};

const closeServerHandlers = async (handlers: ServerHandlers): Promise<void> => {
  await Effect.runPromise(
    Effect.all(
      [
        Effect.tryPromise({
          try: () => handlers.api.dispose(),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
        Effect.tryPromise({
          try: () => handlers.mcp.close(),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
      ],
      { concurrency: "unbounded" },
    ),
  );
};

export const createServerHandlers = async (): Promise<ServerHandlers> => {
  const { executor, plugins } = await getExecutorBundle();
  const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });

  const LocalApi = composePluginApi(plugins);
  // `ErrorCaptureLive` logs causes to the console and returns a short
  // correlation id. Provided above the handler + middleware layers so
  // both the `withCapture` typed-channel translation AND the
  // `observabilityMiddleware` defect catchall see the same
  // implementation.
  const LocalObservability = observabilityMiddleware(LocalApi);
  const LocalApiBase = HttpApiBuilder.layer(LocalApi).pipe(
    Layer.provide(CoreHandlers),
    Layer.provide(LocalObservability),
    Layer.provide(ErrorCaptureLive),
  );

  // Spec-based plugin handlers — each plugin's `handlers(self)` Layer is
  // built against its own bundled HttpApi for full type safety inside the
  // plugin, and merges into the runtime `LocalApi` by group identity.
  // Each plugin's handler bodies that yield its `*ExtensionService` are
  // satisfied because `composePluginHandlers` provides `executor[id]` to
  // the plugin's own `Layer.succeed(*ExtensionService)(self)` wiring.
  const SpecPluginHandlers = composePluginHandlers(plugins, executor);

  const localApiLayer = LocalApiBase.pipe(
    Layer.provideMerge(HttpApiSwagger.layer(LocalApi, { path: "/docs" })),
    Layer.provideMerge(SpecPluginHandlers),
    Layer.provideMerge(Layer.succeed(ExecutorService)(executor)),
    Layer.provideMerge(Layer.succeed(ExecutionEngineService)(engine)),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  );
  const api = HttpRouter.toWebHandler(localApiLayer);
  const apiHandler: ServerHandlers["api"] = {
    handler: (request) => api.handler(request),
    dispose: api.dispose,
  };

  const mcp = createMcpRequestHandler({ engine, plugins });

  return { api: apiHandler, mcp };
};

export class ServerHandlersService extends Context.Service<ServerHandlersService, ServerHandlers>()(
  "@executor-js/local/ServerHandlersService",
) {}

const ServerHandlersLive = Layer.effect(ServerHandlersService)(
  Effect.acquireRelease(
    Effect.promise(() => createServerHandlers()),
    (handlers) => Effect.promise(() => closeServerHandlers(handlers)),
  ),
);

const serverHandlersRuntime = ManagedRuntime.make(ServerHandlersLive);

export const getServerHandlers = (): Promise<ServerHandlers> =>
  serverHandlersRuntime.runPromise(ServerHandlersService.asEffect());

export const disposeServerHandlers = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => serverHandlersRuntime.dispose(),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
  );
};
