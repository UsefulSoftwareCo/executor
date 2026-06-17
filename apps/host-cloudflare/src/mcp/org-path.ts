const PRM_PREFIX = "/.well-known/oauth-protected-resource";

export const stripMcpOrgSegment = (pathname: string): string | null => {
  if (pathname.startsWith(`${PRM_PREFIX}/`)) {
    const rest = pathname
      .slice(PRM_PREFIX.length + 1)
      .split("/")
      .filter((segment) => segment.length > 0);
    return rest.length === 2 && rest[1] === "mcp" ? `${PRM_PREFIX}/mcp` : null;
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return segments.length === 2 && segments[1] === "mcp" ? "/mcp" : null;
};
