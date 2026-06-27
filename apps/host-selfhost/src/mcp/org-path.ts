// Self-host serves MCP at the bare `/mcp` path and bare OAuth discovery docs.
// The console "Connect an agent" card prints an organization-prefixed MCP URL,
// matching the multi-tenant cloud convention. Self-host may remove that prefix
// only when it names this instance's live organization.
//
// Pure and Effect-free on purpose: the Vite config imports the shape detector.

const PRM_PREFIX = "/.well-known/oauth-protected-resource";

export interface McpOrganizationScope {
  readonly id: string;
  readonly slug: string;
}

export type McpOrgPathResolution =
  | { readonly kind: "none" }
  | { readonly kind: "reject" }
  | { readonly kind: "rewrite"; readonly pathname: string };

interface ScopedMcpPath {
  readonly organization: string;
  readonly pathname: string;
}

const parseScopedMcpPath = (pathname: string): ScopedMcpPath | null => {
  if (pathname.startsWith(`${PRM_PREFIX}/`)) {
    const rest = pathname
      .slice(PRM_PREFIX.length + 1)
      .split("/")
      .filter((segment) => segment.length > 0);
    if (rest.length === 2 && rest[1] === "mcp") {
      return { organization: rest[0] ?? "", pathname: PRM_PREFIX };
    }
    if (rest.length === 4 && rest[1] === "mcp" && rest[2] === "toolkits") {
      return {
        organization: rest[0] ?? "",
        pathname: `${PRM_PREFIX}/mcp/toolkits/${rest[3]}`,
      };
    }
    return null;
  }

  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2 && segments[1] === "mcp") {
    return { organization: segments[0] ?? "", pathname: "/mcp" };
  }
  if (segments.length === 4 && segments[1] === "mcp" && segments[2] === "toolkits") {
    return {
      organization: segments[0] ?? "",
      pathname: `/mcp/toolkits/${segments[3]}`,
    };
  }
  return null;
};

/** True when the path has a single organization segment before an MCP route. */
export const isScopedMcpPath = (pathname: string) => parseScopedMcpPath(pathname) !== null;

/**
 * Validate an organization-prefixed MCP or protected-resource path. Valid live
 * organization ids and slugs are rewritten to the provider-neutral bare route;
 * foreign scopes are rejected instead of silently reaching this tenant.
 */
export const resolveMcpOrgPath = (
  pathname: string,
  organization: McpOrganizationScope,
): McpOrgPathResolution => {
  const scoped = parseScopedMcpPath(pathname);
  if (!scoped) return { kind: "none" };
  if (scoped.organization !== organization.id && scoped.organization !== organization.slug) {
    return { kind: "reject" };
  }
  return { kind: "rewrite", pathname: scoped.pathname };
};
