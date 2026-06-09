// Writes runs/manifest.json — the machine-readable inventory the viewer SPA
// renders (scenario × target matrix + per-run metadata). Rebuilt after every
// scenario; the SPA itself is built once by vite (see e2e/viewer/).
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";

export interface ManifestRun {
  readonly scenario: string;
  readonly target: string;
  readonly slug: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly endedAt?: number;
}

export interface ManifestSkip {
  readonly scenario: string;
  readonly target: string;
  readonly missing: ReadonlyArray<string>;
}

export const buildManifest = (runsDir: string): void => {
  const runs: ManifestRun[] = [];
  const skips: ManifestSkip[] = [];

  for (const target of readdirSync(runsDir, { withFileTypes: true })) {
    if (!target.isDirectory() || target.name === "assets") continue;
    // Both vitest projects build the manifest concurrently while runs are
    // being (re)written — tolerate dirs vanishing mid-scan.
    let slugs: Dirent[];
    try {
      slugs = readdirSync(join(runsDir, target.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const dir = join(runsDir, target.name, slug.name);
      const runPath = join(dir, "run.json");
      if (existsSync(runPath)) {
        try {
          const run = JSON.parse(readFileSync(runPath, "utf8"));
          runs.push({
            scenario: run.scenario,
            target: target.name,
            slug: slug.name,
            ok: run.ok,
            durationMs: run.durationMs,
            endedAt: run.endedAt,
          });
          continue;
        } catch {
          // unreadable run — fall through to the skip marker
        }
      }
      const skipPath = join(dir, "skipped.json");
      if (existsSync(skipPath)) {
        try {
          const skip = JSON.parse(readFileSync(skipPath, "utf8"));
          skips.push({ scenario: skip.scenario, target: target.name, missing: skip.missing });
        } catch {
          // ignore
        }
      }
    }
  }

  // Write-then-rename so a concurrent reader/writer never sees a torn file.
  const tmp = join(runsDir, `.manifest-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ generatedAt: Date.now(), runs, skips }, null, 1));
  renameSync(tmp, join(runsDir, "manifest.json"));
};
