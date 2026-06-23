import { Context, Effect, Layer, ManagedRuntime } from "effect";

import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { composeExecutionObservers } from "@executor-js/sdk";
import { makeLocalApiHandler } from "./app";
import { getExecutorBundle } from "./executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";

// ---------------------------------------------------------------------------
// Local server handlers.
//
// The typed plugin `/api` is assembled by `ExecutorApp.make` (see `./app.ts`):
// the same shared facade cloud and self-host use, slotting local's single-user
// identity + the ONE boot executor (the `fixedExecution` seam) + console error
// capture + Swagger. The plugin set is the union of `executor.config.ts`
// (static, typed) and `executor.jsonc#plugins` (dynamic, jiti-loaded), resolved
// inside the boot bundle, so the composition happens after the bundle resolves
// rather than at module-eval time.
//
// The in-process `/mcp` surface stays local-platform: a single-engine handler
// over the SAME boot executor with a browser-approval store + stdio transport
// (not the shared multi-user `McpServingRoutes` envelope), built here and routed
// by the Bun shell in `serve.ts`.
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

export const createServerHandlers = async (token: string): Promise<ServerHandlers> => {
  // The typed `/api` web-handler comes from `ExecutorApp.make` (./app.ts). The
  // boot bearer token is the authoritative `/api` gate (see `identity.ts`).
  const apiHandler: ServerHandlers["api"] = await makeLocalApiHandler(token);

  // The in-process MCP server runs over the SAME boot executor, with its own
  // engine instance (the browser-approval + stdio surface is local-only and not
  // part of the shared API). Reuse the shared boot bundle so the MCP executor is
  // byte-identical to the one the API serves.
  const { executor, plugins } = await getExecutorBundle();
  const engine = createExecutionEngine({
    executor,
    codeExecutor: makeQuickJsExecutor(),
    // Local's in-process MCP also bypasses makeExecutionStack, so compose here.
    observer: composeExecutionObservers(plugins, executor),
  });
  const mcp = createMcpRequestHandler({ engine });

  return { api: apiHandler, mcp };
};

export class ServerHandlersService extends Context.Service<ServerHandlersService, ServerHandlers>()(
  "@executor-js/local/ServerHandlersService",
) {}

// The handlers are built once per process and memoized. The boot token is
// captured on the first call (serve.ts / the vite dev middleware both pass the
// SAME token loaded from `auth.json`), so memoization on first-call is correct.
let serverHandlersRuntime: ManagedRuntime.ManagedRuntime<ServerHandlersService, never> | null =
  null;

const getServerHandlersRuntime = (
  token: string,
): ManagedRuntime.ManagedRuntime<ServerHandlersService, never> => {
  if (serverHandlersRuntime) return serverHandlersRuntime;
  const layer = Layer.effect(ServerHandlersService)(
    Effect.acquireRelease(
      Effect.promise(() => createServerHandlers(token)),
      (handlers) => Effect.promise(() => closeServerHandlers(handlers)),
    ),
  );
  serverHandlersRuntime = ManagedRuntime.make(layer);
  return serverHandlersRuntime;
};

export const getServerHandlers = (token: string): Promise<ServerHandlers> =>
  getServerHandlersRuntime(token).runPromise(ServerHandlersService.asEffect());

export const disposeServerHandlers = async (): Promise<void> => {
  const runtime = serverHandlersRuntime;
  if (!runtime) return;
  serverHandlersRuntime = null;
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => runtime.dispose(),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
  );
};
