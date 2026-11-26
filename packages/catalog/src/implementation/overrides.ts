const mcpQueryDefaults: ReadonlyArray<{ host: string; name: string; value: string }> = [
  { host: "mcp.posthog.com", name: "mode", value: "tools" },
  { host: "mcp.cloudflare.com", name: "codemode", value: "false" },
];

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
