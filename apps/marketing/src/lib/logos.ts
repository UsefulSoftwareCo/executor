const monoLogos = new Set([
  "axiom",
  "chatgpt",
  "codex",
  "copilot",
  "cursor",
  "github",
  "grok",
  "hermes",
  "mcp",
  "opencode",
  "windsurf",
  "x",
  "zed",
]);

export const logoClass = (name: string): string | undefined =>
  monoLogos.has(name) ? "logo-mono" : undefined;
