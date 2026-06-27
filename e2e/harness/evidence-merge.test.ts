import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { mergeEvidenceArtifacts } from "../src/evidence-merge";
import { buildManifest } from "../src/viewer/manifest";

const writeAttempt = (artifactDir: string, attemptId: string, marker: string, scenario: string) => {
  const attemptDir = join(artifactDir, "cloud", "account-switch");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(attemptDir, "evidence.json"),
    JSON.stringify({ schemaVersion: 1, attemptId, createdAt: 1, updatedAt: 1, invocations: [] }),
  );
  writeFileSync(
    join(attemptDir, "result.json"),
    JSON.stringify({ scenario, target: "cloud", attemptId, ok: true, endedAt: 1 }),
  );
  writeFileSync(join(attemptDir, `${marker}.png`), marker);
};

describe("e2e evidence aggregation", () => {
  it.effect("preserves colliding attempt directories and rebuilds one manifest", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-merge-"))),
      (temporary) =>
        Effect.sync(() => {
          const inputDir = join(temporary, "artifacts");
          const outputDir = join(temporary, "runs");
          const portable = join(inputDir, "e2e-cloud-hermetic-3");
          const live = join(inputDir, "e2e-live-cloud-3");
          writeAttempt(portable, "portable-attempt", "portable", "Portable account switch");
          writeAttempt(live, "live-attempt", "live", "Live account switch");
          mkdirSync(join(portable, "assets"), { recursive: true });
          writeFileSync(join(portable, "manifest.json"), "stale manifest");

          const merged = mergeEvidenceArtifacts({ inputDir, outputDir, runAttempt: "3" });
          expect(merged).toMatchObject({
            artifactCount: 2,
            attemptCount: 2,
            collisionCount: 1,
          });
          expect(merged.trustedRuns).toEqual(
            expect.arrayContaining([
              { target: "cloud", slug: "account-switch", project: "cloud-hermetic" },
              {
                target: "cloud",
                slug: "account-switch--live-attempt",
                project: "cloud",
              },
            ]),
          );

          const attempts = readdirSync(join(outputDir, "cloud")).sort();
          expect(attempts).toEqual(["account-switch", "account-switch--live-attempt"]);
          expect(readFileSync(join(outputDir, "cloud", attempts[0], "portable.png"), "utf8")).toBe(
            "portable",
          );
          expect(readFileSync(join(outputDir, "cloud", attempts[1], "live.png"), "utf8")).toBe(
            "live",
          );

          buildManifest(outputDir);
          const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
          expect(manifest.runs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                scenario: "Live account switch",
                slug: "account-switch--live-attempt",
              }),
              expect.objectContaining({
                scenario: "Portable account switch",
                slug: "account-switch",
              }),
            ]),
          );
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );

  it.effect("fails closed when downloaded artifacts contain no attempts", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-empty-"))),
      (temporary) =>
        Effect.sync(() => {
          const inputDir = join(temporary, "artifacts");
          const outputDir = join(temporary, "runs");
          mkdirSync(join(inputDir, "e2e-empty-3"), { recursive: true });
          expect(() => mergeEvidenceArtifacts({ inputDir, outputDir, runAttempt: "3" })).toThrow(
            "found no attempt directories",
          );
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );
});
