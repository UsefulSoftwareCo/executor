// Self-host serves MCP at the bare `/mcp` path (and bare OAuth discovery docs).
// The console "Connect an agent" card, however, prints
// `<origin>/<organizationId>/mcp` — a convention the multi-tenant cloud worker
// routes (it strips the org segment at the edge, carrying the org in a header).
// Self-host is single-tenant: the session already pins the one org, so the org
// segment in the URL carries no routing meaning. Rather than special-case the
// card per host, both self-host front-ends (the prod Bun server and the vite
// dev middleware) strip a single leading segment so the card's URL reaches the
// real route — mirroring cloud's edge rewrite, but accepting ANY segment (a
// Better Auth org id is not the `org_…` shape cloud keys on) and setting no
// header.
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
