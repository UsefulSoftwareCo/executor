// Logos drawn in a single near-black colour. Dark mode inverts them through
// the `.logo-mono` class in styles/global.css; coloured logos stay as they are.
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
