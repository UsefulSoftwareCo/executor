// ---------------------------------------------------------------------------
// Cloud MCP front — test-worker helpers for the shared, provider-neutral
// host-mcp serving envelope (@executor-js/host-mcp) behind cloud's two seams.
// ---------------------------------------------------------------------------
//
// PRODUCTION serves /mcp through `app.ts`'s unified `ExecutorApp.make` handler
// (the same `McpServingRoutes` envelope provided `cloudMcpAuth` +
// `cloudMcpSessions`), dispatched by start.ts alongside /api. This module is the
// TEST-WORKER counterpart: it exposes the two pieces `test-worker.ts` needs to
// build the identical envelope with swapped auth seams —
//   - `makeMcpWebHandler` — bind `McpServingRoutes` to a web handler over a
//     given auth provider + seam requirements + telemetry runtime, mirroring the
//     self-host mount (`HttpRouter.toWebHandler`).
//   - `classifyMcpPath`   — the "is this an MCP path?" predicate (`/mcp` + the
//     two discovery docs) that start.ts's dispatch and the test worker share.
//
// Cloud's two envelope seams:
//   - McpAuthProvider  -> cloudMcpAuthProviderLayer (WorkOS JWT + API key +
//     per-request org-liveness + the two OAuth discovery docs)
//   - McpSessionStore  -> cloudMcpSessionStoreLayer (Durable-Object dispatch)
//
// Streaming passthrough — the DO returns a `Response` whose body is a
// `ReadableStream` (SSE). The envelope wraps it with `HttpServerResponse.raw`,
// which passes the `Response` body through unchanged.
// ---------------------------------------------------------------------------

import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

import { McpServingRoutes } from "@executor-js/host-mcp";

import { McpAuth, McpOrganizationAuth, PROTECTED_RESOURCE_METADATA_PATH } from "./auth";
import { cloudMcpReporter } from "./reporter";
import { cloudMcpSessionStoreLayer } from "./session-store";

const MCP_PATH = "/mcp";

type McpRoute = "mcp" | "oauth-protected-resource" | "oauth-authorization-server" | null;

/**
 * Returns the MCP route type for a pathname, or `null` if the path isn't owned
 * by the MCP handler.
 *
 * Exported so the test worker and start.ts's middleware share the exact same
 * "is this an MCP path?" predicate — under the envelope `HttpRouter.toWebHandler`
 * 404s unknown paths rather than returning `null`, so this gate decides whether
 * to even invoke the envelope handler (null -> fall through to Start routing).
 * The known-path set stays in sync with the envelope's mounted routes:
 * `/mcp` + the two provider-declared discovery paths.
 */
export const classifyMcpPath = (pathname: string): McpRoute => {
  if (pathname === MCP_PATH) return "mcp";
  if (pathname === PROTECTED_RESOURCE_METADATA_PATH) return "oauth-protected-resource";
  if (pathname === "/.well-known/oauth-authorization-server") return "oauth-authorization-server";
  return null;
};

/**
 * Build the envelope web handler from the shared `McpServingRoutes` Layer,
 * provided cloud's two seams. Mirrors the self-host mount (apps/host-selfhost
 * api.ts): `HttpRouter.provideRequest` clears the route handlers' per-request
 * seam requirements, the build-time `Layer.provide(McpAuthProviderLive)`
 * satisfies the `HttpRouter.use` callback's read of `discoveryRoutes`, and
 * `HttpServer.layerServices` supplies the platform services for the web
 * handler binding.
 *
 * `seamsRequirements` resolves the McpAuth + McpOrganizationAuth tags the
 * provider reads; `runtime` (the WebSdk telemetry layer) is provided to the
 * WHOLE router so every route-handler span lands on cloud's tracer — the same
 * tracer the old `mcpApp` was provided.
 *
 * Exported so the test worker can build the same handler with test seam Layers.
 */
export const makeMcpWebHandler = <SeamsError = never>(options: {
  readonly authProvider: Layer.Layer<
    import("@executor-js/host-mcp").McpAuthProvider,
    never,
    McpAuth | McpOrganizationAuth
  >;
  readonly seamsRequirements: Layer.Layer<McpAuth | McpOrganizationAuth, SeamsError>;
  readonly runtime: Layer.Layer<never>;
}): ((request: Request) => Promise<Response>) => {
  const McpAuthProviderLive = options.authProvider.pipe(Layer.provide(options.seamsRequirements));
  const McpSeams = Layer.mergeAll(McpAuthProviderLive, cloudMcpSessionStoreLayer, cloudMcpReporter);
  const McpRouteLive = McpServingRoutes.pipe(
    HttpRouter.provideRequest(McpSeams),
    Layer.provide(McpAuthProviderLive),
  );
  return HttpRouter.toWebHandler(
    McpRouteLive.pipe(
      Layer.provideMerge(Layer.mergeAll(options.runtime, HttpServer.layerServices)),
    ),
  ).handler;
};

// Production no longer mounts /mcp here — `app.ts`'s unified `ExecutorApp.make`
// handler serves it (the same `McpServingRoutes` envelope + cloud seams as
// `cloudMcpAuth`/`cloudMcpSessions`), dispatched by start.ts alongside /api.
// `classifyMcpPath` + `makeMcpWebHandler` remain because the workerd/miniflare
// test worker (`test-worker.ts`) builds the same envelope with swapped auth
// seams and classifies MCP paths with the identical predicate.
