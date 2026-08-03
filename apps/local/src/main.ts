import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";

import { withExecutionAnalytics } from "@executor-js/analytics";
import { createExecutionEngine } from "@executor-js/execution";
import { artifactUrlFor } from "@executor-js/host-mcp/create-artifact";
import { loadMcpAppsShellHtml } from "@executor-js/mcp-apps-shell";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { localAnalytics } from "./analytics";
import { makeLocalApiHandler } from "./app";
import { createExecutorHandle, disposeExecutor, getExecutorBundle } from "./executor";
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

class ServerHandlersDisposeError extends Data.TaggedError("ServerHandlersDisposeError")<{
  readonly operation: "api.dispose" | "mcp.close" | "disposeExecutor" | "runtime.dispose";
  readonly cause: unknown;
}> {}

const ignoreDisposeFailure = (
  operation: ServerHandlersDisposeError["operation"],
  dispose: () => Promise<unknown>,
) =>
  Effect.tryPromise({
    try: dispose,
    catch: (cause) => new ServerHandlersDisposeError({ operation, cause }),
  }).pipe(Effect.ignore);

const closeServerHandlers = async (handlers: ServerHandlers): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.all(
        [
          ignoreDisposeFailure("api.dispose", () => handlers.api.dispose()),
          ignoreDisposeFailure("mcp.close", () => handlers.mcp.close()),
        ],
        { concurrency: "unbounded" },
      );
      // The API/MCP handlers borrow the shared local executor handle. Release it
      // after the surfaces are closed so server shutdown (and failed startup
      // cleanup via disposeServerHandlers) releases the owned data-dir lock.
      yield* ignoreDisposeFailure("disposeExecutor", () => disposeExecutor());
    }),
  );
};

export const createServerHandlers = async (token: string): Promise<ServerHandlers> => {
  let apiHandler: ServerHandlers["api"] | null = null;
  let mcp: McpRequestHandler | null = null;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: handler boot owns the shared executor; partial startup failure must release it before rethrowing
  try {
    // The typed `/api` web-handler comes from `ExecutorApp.make` (./app.ts). The
    // boot bearer token is the authoritative `/api` gate (see `identity.ts`).
    apiHandler = await makeLocalApiHandler(token);

    // The in-process MCP server runs over the SAME boot executor, with its own
    // engine instance (the browser-approval + stdio surface is local-only and not
    // part of the shared API). Reuse the shared boot bundle so the MCP executor is
    // byte-identical to the one the API serves.
    const { executor, webBaseUrl } = await getExecutorBundle();
    // Both engines below serve MCP endpoints, so the wrap binds the "mcp"
    // plane structurally; the toolkit-scoped engine additionally marks
    // `toolkit` (the slug itself is a user label and never recorded).
    const engine = withExecutionAnalytics(
      createExecutionEngine({
        executor,
        codeExecutor: makeQuickJsExecutor(),
      }),
      localAnalytics,
      { plane: "mcp", toolkit: false },
    );
    // The generative-UI surface, shared by every resource this daemon serves.
    // Each toolkit gets its own executor, so `artifacts` is bound per resource
    // below rather than hoisted with the rest.
    //
    // Including the create-time smoke render, on the same terms as every other
    // host. This daemon is a dependency of `apps/cli`, whose build does not
    // configure `jsx`, and the renderer used to be unusable here for that
    // reason — TypeScript resolved its dynamic `import()` of the `.tsx`
    // component barrel eagerly and dragged the whole React graph (plus a
    // duplicate `@types/react`) into the CLI and desktop trees. It renders
    // inside a QuickJS sandbox now, so there is no `.tsx` in its graph and no
    // React in this process; the cost is one lazily-loaded string constant.
    const appsConfig = {
      loadAppShellHtml: loadMcpAppsShellHtml,
      smokeRenderArtifact,
      artifactUrl: artifactUrlFor(webBaseUrl),
      // Artifact operations on this surface come from an agent's MCP tools.
      onArtifactUsage: (action: "created" | "viewed" | "updated") =>
        localAnalytics.record(`artifact_${action}`, { via: "agent" }),
    };
    mcp = createMcpRequestHandler({
      defaultConfig: {
        engine,
        artifacts: executor.artifacts,
        connections: executor.connections,
        ...appsConfig,
      },
      createConfigForResource: async (resource) => {
        if (resource.kind === "default") {
          return {
            config: {
              engine,
              artifacts: executor.artifacts,
              connections: executor.connections,
              ...appsConfig,
            },
          };
        }
        const handle = await createExecutorHandle({
          activeToolkitSlug: resource.slug,
        });
        const toolkitEngine = withExecutionAnalytics(
          createExecutionEngine({
            executor: handle.executor,
            codeExecutor: makeQuickJsExecutor(),
          }),
          localAnalytics,
          { plane: "mcp", toolkit: true },
        );
        return {
          config: {
            engine: toolkitEngine,
            artifacts: handle.executor.artifacts,
            connections: handle.executor.connections,
            ...appsConfig,
          },
          close: handle.dispose,
        };
      },
    });

    return { api: apiHandler, mcp };
  } catch (cause) {
    const partialApiHandler = apiHandler;
    const partialMcp = mcp;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all(
          [
            partialApiHandler
              ? ignoreDisposeFailure("api.dispose", () => partialApiHandler.dispose())
              : Effect.void,
            partialMcp ? ignoreDisposeFailure("mcp.close", () => partialMcp.close()) : Effect.void,
          ],
          { concurrency: "unbounded" },
        );
        yield* ignoreDisposeFailure("disposeExecutor", () => disposeExecutor());
      }),
    );
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: async factory must reject with the original handler boot failure after cleanup
    throw cause;
  }
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
    Effect.gen(function* () {
      yield* ignoreDisposeFailure("runtime.dispose", () => runtime.dispose());
      // Belt-and-suspenders: runtime disposal normally reaches closeServerHandlers,
      // but a failed runtime finalizer must not leave the shared DB owner alive.
      yield* ignoreDisposeFailure("disposeExecutor", () => disposeExecutor());
    }),
  );
};
