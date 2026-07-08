export type SourceSkippedFile = {
  readonly path: string;
  readonly reason: "not supported yet" | "unsupported file type" | "ignored";
};

const TOOL_RE = /^tools\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const DEFERRED_RE = /^(workflows|ui|skills)\//;
const ROOT_SUPPORT_FILES = new Set([
  "executor.json",
  "package.json",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export const isRelevantAppSourcePath = (path: string): boolean =>
  ROOT_SUPPORT_FILES.has(path) || TOOL_RE.test(path);

export const classifyAppSourcePath = (path: string): "fetch" | SourceSkippedFile => {
  if (isRelevantAppSourcePath(path)) return "fetch";
  if (DEFERRED_RE.test(path)) return { path, reason: "not supported yet" };
  return { path, reason: "ignored" };
};
