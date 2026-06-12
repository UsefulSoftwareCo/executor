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

import { isValidOrgSlug } from "@executor-js/api";
import { McpServingRoutes } from "@executor-js/host-mcp";

import {
  McpAuth,
  McpOrganizationAuth,
  MCP_ORGANIZATION_HEADER,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "./auth";
import { cloudMcpReporter } from "./reporter";
import { cloudMcpSessionStoreLayer } from "./session-store";

const MCP_PATH = "/mcp";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

type McpRouteKind = "mcp" | "oauth-protected-resource" | "oauth-authorization-server";

type McpRoute = {
  readonly kind: McpRouteKind;
  /** Org selector pinned in the URL (`/acme/mcp` slug or legacy `/org_xxx/mcp`
   *  id), or `null` for the bare path. Resolved to an org id — and re-checked
   *  against live membership — in the auth provider. */
  readonly organizationId: string | null;
} | null;

// A path segment counts as an org selector when it's the org's URL slug (the
// canonical form the install card prints) or has the WorkOS org-id shape
// (`org_…`, the legacy form already in agents' configs). The slug grammar
// reserves every routable root segment (`integrations`, `api-keys`, …), so an
// unrelated `/<seg>/mcp` still falls through to routing.
const orgSelectorSegment = (segment: string | undefined): string | null =>
  segment && (segment.startsWith("org_") || isValidOrgSlug(segment)) ? segment : null;

// Matches a trailing MCP endpoint — `mcp` (bare) or `<org>/mcp`. Returns the org
// selector, `null` for the bare form, or `undefined` when the segments are neither.
const matchMcpSuffix = (segments: readonly string[]): string | null | undefined => {
  if (segments.length === 1 && segments[0] === "mcp") return null;
  if (segments.length === 2 && segments[1] === "mcp") {
    return orgSelectorSegment(segments[0]) ?? undefined;
  }
  return undefined;
};

/**
 * Returns the MCP route (kind + optional URL-pinned org) for a pathname, or
 * `null` if the path isn't owned by the MCP handler.
 *
 * Exported so the test worker and start.ts's middleware share the exact same
 * "is this an MCP path?" predicate — under the envelope `HttpRouter.toWebHandler`
 * 404s unknown paths rather than returning `null`, so this gate decides whether
 * to even invoke the envelope handler (null -> fall through to Start routing).
 * Recognizes the bare `/mcp` + the two discovery docs AND their org-scoped
 * variants (`/org_xxx/mcp`, `/.well-known/oauth-protected-resource/org_xxx/mcp`);
 * only `org_…`-shaped segments are claimed. `prepareMcpOrgScope` then rewrites an
 * org-scoped path to the bare path the shared envelope actually routes.
 */
export const classifyMcpPath = (pathname: string): McpRoute => {
  if (pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
    return { kind: "oauth-authorization-server", organizationId: null };
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  // Protected-resource metadata: `${prefix}/mcp` or `${prefix}/<org>/mcp`. The
  // org sits after the well-known prefix (RFC 9728), not at the path root.
  const prmPrefix = "/.well-known/oauth-protected-resource";
  if (pathname.startsWith(`${prmPrefix}/`)) {
    const organizationId = matchMcpSuffix(segments.slice(2));
    return organizationId === undefined
      ? null
      : { kind: "oauth-protected-resource", organizationId };
  }

  // MCP transport: `/mcp` or `/<org>/mcp`.
  const organizationId = matchMcpSuffix(segments);
  return organizationId === undefined ? null : { kind: "mcp", organizationId };
};

const bareMcpPath = (kind: McpRouteKind): string =>
  kind === "mcp"
    ? MCP_PATH
    : kind === "oauth-protected-resource"
      ? PROTECTED_RESOURCE_METADATA_PATH
      : AUTHORIZATION_SERVER_METADATA_PATH;

/**
 * Normalize an org-scoped MCP request for the shared envelope, which routes ONLY
 * the bare `/mcp` + bare discovery paths. Rewrites `/org_xxx/mcp` (and the
 * org-scoped discovery doc) to its bare path and carries the URL-pinned org in
 * the internal `MCP_ORGANIZATION_HEADER` the cloud provider reads. A bare path is
 * left untouched, except any client-supplied org header is stripped — the org may
 * come ONLY from the URL (membership is still re-checked per request, so this is
 * a selector, not a trust boundary). Shared by start.ts (production) and the test
 * worker so both classify + rewrite identically; a no-op for non-MCP paths.
 */
export const prepareMcpOrgScope = (request: Request): Request => {
  const url = new URL(request.url);
  const route = classifyMcpPath(url.pathname);
  if (route === null) return request;
  const bare = bareMcpPath(route.kind);
  if (url.pathname === bare && !request.headers.has(MCP_ORGANIZATION_HEADER)) return request;
  url.pathname = bare;
  const rewritten = new Request(url, request);
  if (route.organizationId) rewritten.headers.set(MCP_ORGANIZATION_HEADER, route.organizationId);
  else rewritten.headers.delete(MCP_ORGANIZATION_HEADER);
  return rewritten;
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
