import { defaultMcpResource, type McpResource } from "@executor-js/host-mcp";

export const mcpResourceFromPath = (pathname: string): McpResource | null => {
  if (pathname === "/mcp") return defaultMcpResource;

  const toolkitMatch = /^\/mcp\/toolkits\/([^/]+)$/.exec(pathname);
  return toolkitMatch?.[1] ? { kind: "toolkit", slug: toolkitMatch[1] } : null;
};
