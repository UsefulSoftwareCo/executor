const clientFamilies = [
  ["executor-cli", /\bexecutor cli\b/iu],
  ["claude-code", /\bclaude[ -]?code\b/iu],
  ["claude-desktop", /\bclaude desktop\b/iu],
  ["claude-ai", /\bclaude(?:\.?ai)?\b/iu],
  ["codex", /\bcodex\b/iu],
  ["chatgpt", /\bchatgpt\b/iu],
  ["cursor", /\bcursor\b/iu],
  ["vscode", /\b(?:visual studio code|vs ?code)\b/iu],
  ["windsurf", /\b(?:windsurf|codeium)\b/iu],
] as const;

export type NamedClientFamily = (typeof clientFamilies)[number][0] | "other";

export const clientFamilyOfName = (name: string): NamedClientFamily =>
  clientFamilies.find(([, pattern]) => pattern.test(name))?.[0] ?? "other";
