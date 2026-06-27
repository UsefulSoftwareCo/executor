import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { laneProvenanceFor } from "../src/evidence-provenance";
import {
  evidenceRunUrl,
  evidenceSummaryMarkdown,
  evidenceViewerUrl,
  latestSummaryRuns,
  r2ObjectUrl,
  summaryRunsFromManifest,
  validateEvidenceBundle,
  verifyPublishedEvidence,
} from "../src/evidence-publication";
import { TRUSTED_RUN_LANES_SOURCE, type TrustedRunLanes } from "../src/evidence-trust";

const sourceRevision = "0123456789abcdef";

const trustedRuns = (project = "cloud-hermetic"): TrustedRunLanes => ({
  schemaVersion: 1,
  source: TRUSTED_RUN_LANES_SOURCE,
  runAttempt: "1",
  runs: [{ target: "cloud", slug: "account-switch", project }],
});

const publication = (binaryArtifacts: ReadonlyArray<string> = []) => ({
  schemaVersion: 1,
  sanitizedAt: 1,
  status: "passed",
  sanitizer: {
    source: "e2e/scripts/sanitize-evidence.ts",
    policyVersion: 1,
    sourceRevision,
  },
  policy: {
    unknownArtifacts: "removed",
    textAndJson: "redacted",
    binaryVisuals: "unredacted-synthetic-only",
    binarySecretDetection: "byte-canary-only",
  },
  runtime: { name: "bun", version: "1.3.11", platform: "linux", arch: "x64" },
  stats: { removed: 0, redacted: 2, retained: 1, canariesChecked: 0 },
  binaryArtifacts,
  errors: [],
});

const writeBundle = (root: string) => {
  const runDirectory = join(root, "cloud", "account-switch");
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(root, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      generatedAt: 1,
      runs: [
        {
          scenario: "Account switch",
          target: "cloud",
          slug: "account-switch",
          ok: true,
          endedAt: 2,
          artifacts: [{ name: "result.json", kind: "json" }],
        },
      ],
      skips: [],
    }),
  );
  writeFileSync(join(root, "publication.json"), JSON.stringify(publication()));
  writeFileSync(
    join(runDirectory, "lane-provenance.json"),
    JSON.stringify(laneProvenanceFor("cloud-hermetic", "cloud")),
  );
  writeFileSync(
    join(runDirectory, "result.json"),
    JSON.stringify({ scenario: "Account switch", target: "cloud", ok: true, artifacts: [] }),
  );
};

describe("evidence static publication", () => {
  it.effect("validates a sanitized bundle and fails closed on post-sanitize files", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-publication-"))),
      (temporary) =>
        Effect.sync(() => {
          writeBundle(temporary);
          const bundle = validateEvidenceBundle(temporary, sourceRevision, trustedRuns());
          expect(bundle.files.map((file) => file.relativePath).sort()).toEqual([
            "cloud/account-switch/lane-provenance.json",
            "cloud/account-switch/result.json",
            "index.html",
            "manifest.json",
            "publication.json",
          ]);

          writeFileSync(join(temporary, "credentials.json"), "private");
          expect(() => validateEvidenceBundle(temporary, sourceRevision, trustedRuns())).toThrow(
            "private artifact",
          );
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );

  it.effect("rejects forged hermetic provenance against external live-lane metadata", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-forgery-"))),
      (temporary) =>
        Effect.sync(() => {
          writeBundle(temporary);
          expect(() =>
            validateEvidenceBundle(temporary, sourceRevision, trustedRuns("cloud")),
          ).toThrow("publication lane provenance does not match external trusted project cloud");
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );

  it.effect("requires the sanitizer's binary inventory to match visual evidence", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-visual-"))),
      (temporary) =>
        Effect.sync(() => {
          writeBundle(temporary);
          writeFileSync(join(temporary, "cloud", "account-switch", "failure.png"), "png");
          expect(() => validateEvidenceBundle(temporary, sourceRevision, trustedRuns())).toThrow(
            "binary artifact inventory",
          );
          writeFileSync(
            join(temporary, "publication.json"),
            JSON.stringify(publication(["cloud/account-switch/failure.png"])),
          );
          expect(
            validateEvidenceBundle(temporary, sourceRevision, trustedRuns()).files,
          ).toHaveLength(6);
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );

  it.effect("reads back the public index and control manifests before surfacing a URL", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-readback-"))),
      (temporary) =>
        Effect.gen(function* () {
          writeBundle(temporary);
          const bundle = validateEvidenceBundle(temporary, sourceRevision, trustedRuns());
          const byName = new Map(bundle.files.map((file) => [file.relativePath, file]));
          const requests: string[] = [];
          const verification = yield* Effect.promise(() =>
            verifyPublishedEvidence({
              viewerUrl: "https://previews.example.test/e2e/run-1/index.html",
              files: bundle.files,
              attempts: 2,
              retryDelayMs: 0,
              fetcher: async (url) => {
                requests.push(url);
                const relativePath = new URL(url).pathname.split("/").at(-1) ?? "";
                const file = byName.get(relativePath);
                if (!file) return new Response("missing", { status: 404 });
                if (relativePath === "manifest.json" && requests.length === 1) {
                  return new Response("not ready", { status: 404 });
                }
                return new Response(new Uint8Array(readFileSync(file.absolutePath)), {
                  headers: { "content-type": file.artifact.mime },
                });
              },
            }),
          );
          expect(verification).toEqual({ verifiedFiles: 3 });
          expect(requests).toEqual([
            "https://previews.example.test/e2e/run-1/manifest.json",
            "https://previews.example.test/e2e/run-1/manifest.json",
            "https://previews.example.test/e2e/run-1/publication.json",
            "https://previews.example.test/e2e/run-1/index.html",
          ]);
        }),
      (temporary) => Effect.sync(() => rmSync(temporary, { recursive: true, force: true })),
    ),
  );

  it("builds immutable CDN paths and canonical direct run links", () => {
    const viewerUrl = evidenceViewerUrl(
      "https://previews.example.test/executor/",
      "e2e/repo-42/pr-7/run-100/attempt-2",
    );
    expect(viewerUrl).toBe(
      "https://previews.example.test/executor/e2e/repo-42/pr-7/run-100/attempt-2/index.html",
    );
    expect(evidenceRunUrl(viewerUrl, "cloud", "account-switch")).toBe(
      `${viewerUrl}#/run/cloud/account-switch`,
    );
    expect(
      r2ObjectUrl(
        "https://account.r2.cloudflarestorage.com",
        "executor-previews",
        "e2e/repo-42/pr-7/run-100/attempt-2",
        "assets/index-AbC123.js",
      ),
    ).toBe(
      "https://account.r2.cloudflarestorage.com/executor-previews/e2e/repo-42/pr-7/run-100/attempt-2/assets/index-AbC123.js",
    );
  });

  it("emits the same latest run per scenario and target as the viewer matrix", () => {
    const viewerUrl = "https://previews.example.test/e2e/run-1/index.html";
    const runs = summaryRunsFromManifest({
      runs: [
        {
          scenario: "Account | switch [primary]",
          target: "cloud",
          slug: "old-run",
          ok: false,
          endedAt: 1,
        },
        {
          scenario: "Account | switch [primary]",
          target: "cloud",
          slug: "new-run",
          ok: true,
          endedAt: 2,
        },
        {
          scenario: "Account | switch [primary]",
          target: "selfhost",
          slug: "selfhost-run",
          ok: true,
          endedAt: 1,
        },
      ],
    });
    expect(latestSummaryRuns(runs).map((run) => run.slug)).toEqual(["new-run", "selfhost-run"]);
    const markdown = evidenceSummaryMarkdown(viewerUrl, runs);
    expect(markdown).toContain("Account \\| switch \\[primary\\]");
    expect(markdown).toContain(`${viewerUrl}#/run/cloud/new-run`);
    expect(markdown).not.toContain("old-run");
  });
});
