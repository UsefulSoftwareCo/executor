// Writes runs/manifest.json, the machine-readable inventory the matrix
// renders (scenario × target + per-run status). Rebuilt after every scenario.
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { withArtifactLockSync, writeJsonAtomicSync } from "../artifact-io";
import { publishedArtifactFor, type PublishedArtifactKind } from "../published-artifacts";

export interface ManifestArtifact {
  readonly name: string;
  readonly kind: PublishedArtifactKind;
  readonly label?: string;
}

export interface ManifestRun {
  readonly scenario: string;
  readonly target: string;
  readonly slug: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly endedAt?: number;
  readonly attemptId?: string;
  readonly portableTraceCount?: number;
  readonly portableTraceMissing?: number;
  readonly artifacts: ReadonlyArray<ManifestArtifact>;
}

export interface ManifestSkip {
  readonly scenario: string;
  readonly target: string;
  readonly missing: ReadonlyArray<string>;
}

const artifactLabel = (name: string): string =>
  name
    .replace(/\.[^.]+$/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => (part === "claude" ? "Claude" : part === "mcp" ? "MCP" : part))
    .join(" ");

const artifactsFor = (target: string, slug: string, dir: string): ManifestArtifact[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        if (!entry.isFile()) return [];
        const artifact = publishedArtifactFor(`${target}/${slug}/${entry.name}`);
        return artifact
          ? [{ name: entry.name, kind: artifact.kind, label: artifactLabel(entry.name) }]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
};

export const buildManifest = (runsDir: string): void => {
  const manifestFile = join(runsDir, "manifest.json");
  withArtifactLockSync(manifestFile, () => {
    const runs: ManifestRun[] = [];
    const skips: ManifestSkip[] = [];

    for (const target of readdirSync(runsDir, { withFileTypes: true })) {
      if (!target.isDirectory() || target.name === "assets") continue;
      // Both vitest projects build the manifest concurrently while runs are
      // being (re)written, so tolerate dirs vanishing mid-scan.
      let slugs: Dirent[];
      try {
        slugs = readdirSync(join(runsDir, target.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const slug of slugs) {
        if (!slug.isDirectory()) continue;
        const dir = join(runsDir, target.name, slug.name);
        const resultPath = join(dir, "result.json");
        if (existsSync(resultPath)) {
          try {
            const result = JSON.parse(readFileSync(resultPath, "utf8"));
            runs.push({
              scenario: result.scenario,
              target: target.name,
              slug: slug.name,
              ok: result.ok,
              durationMs: result.durationMs,
              endedAt: result.endedAt,
              ...(typeof result.attemptId === "string" ? { attemptId: result.attemptId } : {}),
              ...(typeof result.portableTraces?.exported === "number"
                ? { portableTraceCount: result.portableTraces.exported }
                : {}),
              ...(typeof result.portableTraces?.missing === "number"
                ? { portableTraceMissing: result.portableTraces.missing }
                : {}),
              artifacts: artifactsFor(target.name, slug.name, dir),
            });
            continue;
          } catch {
            // Unreadable result, fall through to the skip marker.
          }
        }
        const skipPath = join(dir, "skipped.json");
        if (existsSync(skipPath)) {
          try {
            const skip = JSON.parse(readFileSync(skipPath, "utf8"));
            skips.push({ scenario: skip.scenario, target: target.name, missing: skip.missing });
          } catch {
            // Ignore incomplete skip markers.
          }
        }
      }
    }

    writeJsonAtomicSync(manifestFile, { generatedAt: Date.now(), runs, skips });
  });
};
