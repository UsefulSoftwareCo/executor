/** Product defaults for custom MCP URLs. */

/**
 * Servers that hide their tools behind a wrapper unless asked. Executor already provides code
 * execution, so it asks for the individual tools. An explicit value in the URL is kept.
 */
const mcpQueryDefaults: ReadonlyArray<{ host: string; name: string; value: string }> = [
  // PostHog otherwise exposes a CLI wrapper.
  { host: "mcp.posthog.com", name: "mode", value: "tools" },
  // Cloudflare otherwise exposes a single code-mode tool.
  { host: "mcp.cloudflare.com", name: "codemode", value: "false" },
];

/** Apply provider query defaults to a remote MCP URL. Unparseable URLs are left for validation. */
export const applyMcpUrlDefaults = (href: string): string => {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);
  let changed = false;
  for (const rule of mcpQueryDefaults) {
    if (url.hostname !== rule.host || url.searchParams.has(rule.name)) continue;
    url.searchParams.set(rule.name, rule.value);
    changed = true;
  }
  return changed ? url.href : href;
};
