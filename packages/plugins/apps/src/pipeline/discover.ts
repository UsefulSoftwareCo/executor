import { Data } from "effect";

// ---------------------------------------------------------------------------
// discover: shape validation over the flat scope layout, with zero imports.
// Supported now:
//   tools/<name>.ts
// Deferred known folders are skipped and reported:
//   workflows/   ui/   skills/
// Unknown top-level files and folders are ignored.
// ---------------------------------------------------------------------------

export interface FileDiagnostic {
  readonly path: string;
  readonly message: string;
}

/** Typed publish failure carrying per-file diagnostics. Nothing is persisted on
 *  a failed publish. */
export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
  readonly stage: "discover" | "bundle" | "collect" | "project";
  readonly diagnostics: readonly FileDiagnostic[];
}> {}

export type ArtifactKind = "tool";

export interface DiscoveredArtifact {
  readonly kind: ArtifactKind;
  /** Path identity, e.g. `issues-sync`. */
  readonly name: string;
  /** The entry file path in the set, e.g. `tools/issues-sync.ts`. */
  readonly entry: string;
}

export interface SkippedArtifact {
  readonly path: string;
  readonly reason: "not supported yet";
}

export interface DiscoverResult {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly skipped: readonly SkippedArtifact[];
}

const TOOL_RE = /^tools\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const DEFERRED_RE = /^(workflows|ui|skills)\//;

export const discover = (files: ReadonlyMap<string, string>): DiscoverResult | PublishError => {
  const diagnostics: FileDiagnostic[] = [];
  const artifacts: DiscoveredArtifact[] = [];
  const skipped: SkippedArtifact[] = [];
  const seen = new Set<string>();

  for (const [path] of files) {
    if (path === "executor.json") continue;

    const tool = path.match(TOOL_RE);
    if (tool) {
      const name = tool[1];
      const key = `tool:${name}`;
      if (seen.has(key)) {
        diagnostics.push({ path, message: `duplicate artifact identity: ${key}` });
      } else {
        seen.add(key);
        artifacts.push({ kind: "tool", name, entry: path });
      }
      continue;
    }

    if (path.startsWith("tools/")) {
      diagnostics.push({
        path,
        message: "file does not match the expected layout for tools/",
      });
      continue;
    }

    if (DEFERRED_RE.test(path)) {
      skipped.push({ path, reason: "not supported yet" });
    }
  }

  if (diagnostics.length > 0) {
    return new PublishError({
      message: `discover found ${diagnostics.length} problem(s)`,
      stage: "discover",
      diagnostics,
    });
  }

  return { artifacts, skipped };
};
