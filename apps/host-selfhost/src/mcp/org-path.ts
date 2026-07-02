// Self-host serves MCP at the bare `/mcp` path (and bare OAuth discovery docs).
// The console "Connect an agent" card, however, prints
// `<origin>/<organizationId>/mcp` — a convention the multi-tenant cloud worker
// routes (it strips the org segment at the edge, carrying the org in a header).
// Self-host is single-tenant: the session already pins the one org, so the org
// segment in the URL carries no routing meaning. Rather than special-case the
// card per host, both self-host front-ends (the prod Bun server and the vite
// dev middleware) strip a single leading segment so the card's URL reaches the
// real route — mirroring cloud's edge rewrite, but accepting ANY segment (a
// Better Auth org id is not the `org_…` shape cloud keys on). Unlike cloud,
// which carries the org in a header for routing, self-host's rewrite carries
// the ORIGINAL org-scoped pathname in `MCP_ORIGINAL_PATH_HEADER` below, purely
// so the protected-resource metadata (./auth.ts) can echo the org-scoped form
// back to a client that dialed org-scoped (RFC 9728 same-origin check).
//
// Pure + Effect-free on purpose: the vite config imports it too.

const PRM_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * Given a request pathname, return the bare MCP pathname it should route to
 * when it carries a single leading org segment, or `null` when no rewrite
 * applies (already bare, not an MCP path, or an OAuth endpoint like
 * `/api/auth/mcp/authorize`).
 *
 *   /<seg>/mcp                                                -> /mcp
 *   /<seg>/mcp/toolkits/<toolkit>                             -> /mcp/toolkits/<toolkit>
 *   /.well-known/oauth-protected-resource/<seg>/mcp           -> /.well-known/oauth-protected-resource
 *   /.well-known/oauth-protected-resource/<seg>/mcp/toolkits/<toolkit>
 *                                                            -> /.well-known/oauth-protected-resource/mcp/toolkits/<toolkit>
 */
export const stripMcpOrgSegment = (pathname: string): string | null => {
  if (pathname.startsWith(`${PRM_PREFIX}/`)) {
    const rest = pathname
      .slice(PRM_PREFIX.length + 1)
      .split("/")
      .filter((segment) => segment.length > 0);
    if (rest.length === 2 && rest[1] === "mcp") return PRM_PREFIX;
    if (rest.length === 4 && rest[1] === "mcp" && rest[2] === "toolkits") {
      return `${PRM_PREFIX}/mcp/toolkits/${rest[3]}`;
    }
    return null;
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2 && segments[1] === "mcp") return "/mcp";
  if (segments.length === 4 && segments[1] === "mcp" && segments[2] === "toolkits") {
    return `/mcp/toolkits/${segments[3]}`;
  }
  return null;
};

/**
 * Header the strip middleware (serve.ts's Effect middleware and the vite dev
 * middleware) attaches to a rewritten request, carrying the ORIGINAL org-scoped
 * pathname the client actually dialed. `stripMcpOrgSegment` discards that
 * pathname when it rewrites `request.url` to the bare route, but the
 * protected-resource metadata handlers (./auth.ts) need it back to advertise a
 * `resource` that path-prefix-matches what the client dialed (RFC 9728 /
 * `checkResourceAllowed`) — otherwise an org-scoped client never completes
 * discovery. Only ever set to a value that `stripMcpOrgSegment` itself
 * recognizes (see `isRecognizedMcpOrgPath`); any client-supplied value of this
 * header is stripped at the same middleware boundary so it can't be spoofed.
 */
export const MCP_ORIGINAL_PATH_HEADER = "x-executor-mcp-original-path";

/**
 * Whether `pathname` is one `stripMcpOrgSegment` would recognize and rewrite,
 * i.e. a safe value for `MCP_ORIGINAL_PATH_HEADER`. Used to validate the
 * header on the way IN (auth.ts must not trust an arbitrary string), not just
 * on the way out.
 */
export const isRecognizedMcpOrgPath = (pathname: string): boolean =>
  stripMcpOrgSegment(pathname) !== null;

/**
 * Given a recognized original pathname (a `MCP_ORIGINAL_PATH_HEADER` value —
 * either the org-scoped MCP path itself, or its PRM-prefixed discovery-doc
 * form), return the org-scoped MCP resource path alone:
 *
 *   /<org>/mcp                                                -> /<org>/mcp
 *   /<org>/mcp/toolkits/<toolkit>                             -> /<org>/mcp/toolkits/<toolkit>
 *   /.well-known/oauth-protected-resource/<org>/mcp           -> /<org>/mcp
 *   /.well-known/oauth-protected-resource/<org>/mcp/toolkits/<toolkit>
 *                                                            -> /<org>/mcp/toolkits/<toolkit>
 *
 * `null` when `pathname` isn't one `stripMcpOrgSegment` recognizes.
 */
export const mcpResourcePathFromOriginalPath = (pathname: string): string | null => {
  if (!isRecognizedMcpOrgPath(pathname)) return null;
  return pathname.startsWith(`${PRM_PREFIX}/`) ? pathname.slice(PRM_PREFIX.length) : pathname;
};
