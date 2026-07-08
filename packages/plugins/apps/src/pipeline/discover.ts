import { Data } from "effect";

export interface FileDiagnostic {
  readonly path: string;
  readonly message: string;
}

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
  readonly stage: "discover" | "bundle" | "collect" | "project";
  readonly diagnostics: readonly FileDiagnostic[];
}> {}

export interface DiscoveredTool {
  readonly name: string;
  readonly entry: string;
}

export interface SkippedArtifact {
  readonly path: string;
  readonly reason: "not supported yet";
}

export interface DiscoverResult {
  readonly tools: readonly DiscoveredTool[];
  readonly skipped: readonly SkippedArtifact[];
}

const TOOL_RE = /^tools\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const DEFERRED_RE = /^(workflows|ui|skills)\//;

export const validToolKey = (key: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(key);

export const discover = (files: ReadonlyMap<string, string>): DiscoverResult | PublishError => {
  const diagnostics: FileDiagnostic[] = [];
  const tools: DiscoveredTool[] = [];
  const skipped: SkippedArtifact[] = [];
  const seen = new Set<string>();

  for (const [path] of files) {
    if (path === "executor.json") continue;
    const tool = path.match(TOOL_RE);
    if (tool) {
      const name = tool[1]!;
      if (seen.has(name)) {
        diagnostics.push({ path, message: `duplicate tool identity: ${name}` });
      } else {
        seen.add(name);
        tools.push({ name, entry: path });
      }
      continue;
    }
    if (path.startsWith("tools/")) {
      diagnostics.push({ path, message: "file does not match the expected layout for tools/" });
      continue;
    }
    if (DEFERRED_RE.test(path)) skipped.push({ path, reason: "not supported yet" });
  }

  if (diagnostics.length > 0) {
    return new PublishError({
      message: `discover found ${diagnostics.length} problem(s)`,
      stage: "discover",
      diagnostics,
    });
  }
  return { tools, skipped };
};
