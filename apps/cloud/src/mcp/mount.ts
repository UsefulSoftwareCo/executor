// ---------------------------------------------------------------------------
// Cloud MCP front — the MCP-path predicate + org-scope rewrite shared by
// `server.ts`'s request dispatch.
// ---------------------------------------------------------------------------
//
// PRODUCTION serves /mcp through `server.ts`'s hibernatable Agent bridge.
// Discovery docs flow through `app.ts`'s unified `ExecutorApp.make` handler
// (the `auth` seam's discovery routes). This module exposes:
//   - `classifyMcpPath`   — the "is this an MCP path?" predicate (`/mcp` + the
//     two discovery docs, plus their org-scoped variants).
//   - `prepareMcpOrgScope` — rewrite an org-scoped MCP request to the bare path
//     the handler routes, carrying the URL-pinned org in an internal header.
// ---------------------------------------------------------------------------

import { isValidOrgSlug } from "@executor-js/api";

import { MCP_ORGANIZATION_HEADER, PROTECTED_RESOURCE_METADATA_PATH } from "./auth";

const MCP_PATH = "/mcp";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

type McpRouteKind = "mcp" | "oauth-protected-resource" | "oauth-authorization-server";

type McpRoute = {
  readonly kind: McpRouteKind;
  /** Org selector pinned in the URL (`/acme/mcp` slug or legacy `/org_xxx/mcp`
   *  id), or `null` for the bare path. Resolved to an org id — and re-checked
   *  against live membership — in the auth provider. */
  readonly organizationId: string | null;
  readonly toolkitSlug?: string;
} | null;

// A path segment counts as an org selector when it's the org's URL slug (the
// canonical form the install card prints) or has the WorkOS org-id shape
// (`org_…`, the legacy form already in agents' configs). The slug grammar
// reserves every routable root segment (`integrations`, `api-keys`, …), so an
// unrelated `/<seg>/mcp` still falls through to routing.
const orgSelectorSegment = (segment: string | undefined): string | null =>
  segment && (segment.startsWith("org_") || isValidOrgSlug(segment)) ? segment : null;

type MatchedMcpSuffix = {
  readonly organizationId: string | null;
  readonly toolkitSlug?: string;
};

// Matches a trailing MCP endpoint: `mcp`, `mcp/toolkits/<slug>`, or either with
// a leading org selector. Returns undefined when the segments are not MCP.
const matchMcpSuffix = (segments: readonly string[]): MatchedMcpSuffix | undefined => {
  if (segments.length === 1 && segments[0] === "mcp") return { organizationId: null };
  if (segments.length === 3 && segments[0] === "mcp" && segments[1] === "toolkits") {
    const toolkitSlug = segments[2];
    return toolkitSlug ? { organizationId: null, toolkitSlug } : undefined;
  }
  if (segments.length === 2 && segments[1] === "mcp") {
    const organizationId = orgSelectorSegment(segments[0]);
    return organizationId ? { organizationId } : undefined;
  }
  if (segments.length === 4 && segments[1] === "mcp" && segments[2] === "toolkits") {
    const organizationId = orgSelectorSegment(segments[0]);
    const toolkitSlug = segments[3];
    return organizationId && toolkitSlug ? { organizationId, toolkitSlug } : undefined;
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
    const matched = matchMcpSuffix(segments.slice(2));
    return matched === undefined ? null : { kind: "oauth-protected-resource", ...matched };
  }

  // MCP transport: `/mcp` or `/<org>/mcp`.
  const matched = matchMcpSuffix(segments);
  return matched === undefined ? null : { kind: "mcp", ...matched };
};

const bareMcpPath = (route: Exclude<McpRoute, null>): string =>
  route.kind === "mcp"
    ? route.toolkitSlug
      ? `${MCP_PATH}/toolkits/${route.toolkitSlug}`
      : MCP_PATH
    : route.kind === "oauth-protected-resource"
      ? route.toolkitSlug
        ? `${PROTECTED_RESOURCE_METADATA_PATH}/toolkits/${route.toolkitSlug}`
        : PROTECTED_RESOURCE_METADATA_PATH
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
  const bare = bareMcpPath(route);
  if (url.pathname === bare && !request.headers.has(MCP_ORGANIZATION_HEADER)) return request;
  url.pathname = bare;
  const rewritten = new Request(url, request);
  if (route.organizationId) rewritten.headers.set(MCP_ORGANIZATION_HEADER, route.organizationId);
  else rewritten.headers.delete(MCP_ORGANIZATION_HEADER);
  return rewritten;
};

// Production no longer mounts the /mcp transport here. `server.ts` intercepts MCP
// transport requests for the hibernatable Agent bridge, while `ExecutorApp.make`
// serves the OAuth discovery docs through the `auth` seam's discovery routes.
// `classifyMcpPath` + `prepareMcpOrgScope` remain because `server.ts`'s request
// dispatch uses them to recognize and normalize MCP paths.
