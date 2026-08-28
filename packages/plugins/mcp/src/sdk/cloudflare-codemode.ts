// Cloudflare's hosted MCP server (mcp.cloudflare.com) defaults to "code
// mode": it hides the tool catalog behind a single code-execution tool.
// Executor is itself a code-execution surface, so nesting code mode buries
// every real Cloudflare tool. The preset pins `?codemode=false`; hand-entered
// endpoints are flagged so the user adds the same opt-out.

/** Whether `endpoint` targets Cloudflare's MCP server without the
 *  `codemode=false` opt-out. Unparseable and non-Cloudflare URLs are fine. */
export const cloudflareNeedsCodemodeOptOut = (endpoint: string): boolean => {
  const trimmed = endpoint.trim();
  if (!URL.canParse(trimmed)) return false;
  const url = new URL(trimmed);
  if (url.hostname !== "mcp.cloudflare.com") return false;
  return url.searchParams.get("codemode") !== "false";
};
