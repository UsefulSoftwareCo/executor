import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { claimPorts } from "../src/ports";
import { laneProvenanceFor, visualEvidencePublicationDecision } from "../src/evidence-provenance";
import {
  publishedArtifactFor,
  sanitizePublishedJson,
  sanitizePublishedValue,
  syntheticVisualEvidenceDeclaration,
} from "../src/published-artifacts";

const execute = promisify(execFile);
const bun = process.versions.bun ? process.execPath : "bun";
const sanitizer = fileURLToPath(new URL("../scripts/sanitize-evidence.ts", import.meta.url));
const artifactModule = fileURLToPath(new URL("../src/artifact-io.ts", import.meta.url));
const traceModule = fileURLToPath(new URL("../src/trace-harvest.ts", import.meta.url));
const timelineModule = fileURLToPath(new URL("../src/timeline.ts", import.meta.url));

const writeLaneProvenance = (runDir: string, project: string, target: string): void => {
  const provenance = laneProvenanceFor(project, target);
  if (!provenance) throw new Error(`missing test lane provenance for ${project}/${target}`);
  writeFileSync(join(runDir, "lane-provenance.json"), JSON.stringify(provenance));
};

const withTemporaryDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-evidence-test-"))),
    use,
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );

describe("e2e evidence publication", () => {
  it("allows only intentional review artifacts and recursively redacts JSON", () => {
    expect(publishedArtifactFor("cloud/example/result.json")?.kind).toBe("json");
    expect(publishedArtifactFor("cloud/example/lane-provenance.json")?.kind).toBe("json");
    expect(publishedArtifactFor("publication.json")?.kind).toBe("json");
    expect(publishedArtifactFor("cloud/example/00-open-settings.png")?.kind).toBe("binary");
    expect(
      publishedArtifactFor(
        "desktop-kvm/2026-06-27T00-00-00-000Z-1234/renderer-after-settings-click.png",
      )?.kind,
    ).toBe("binary");
    expect(publishedArtifactFor("desktop-kvm/UnexpectedUppercase/failure.png")).toBeUndefined();
    expect(publishedArtifactFor("desktop/traffic-light/01-sidebar-header-webview.png")?.kind).toBe(
      "binary",
    );
    expect(publishedArtifactFor("desktop/traffic-light/01-sidebar-header-overlap.png")?.kind).toBe(
      "binary",
    );
    expect(publishedArtifactFor("cloud/example/mcporter.json")).toBeUndefined();
    expect(publishedArtifactFor("cloud/example/cli-home/server-connections.json")).toBeUndefined();
    expect(publishedArtifactFor("cloud/example/trace.zip")).toBeUndefined();
    expect(publishedArtifactFor("cloud/example/trace.zip", { includeRawTrace: true })?.mime).toBe(
      "application/zip",
    );

    expect(
      sanitizePublishedValue({
        accessToken: "top-secret",
        email: "person@example.com",
        nested: { url: "http://localhost/callback?code=secret-code&safe=yes" },
        path: "/home/example/Developer/executor",
      }),
    ).toEqual({
      accessToken: "[REDACTED]",
      email: "[REDACTED]",
      nested: { url: "http://localhost/callback?code=[REDACTED]&safe=yes" },
      path: "/home/[USER]/Developer/executor",
    });

    const result = sanitizePublishedJson(
      "cloud/example/result.json",
      JSON.stringify({
        error: "Authorization: Bearer secret-value",
        artifacts: ["terminal.cast", "trace.zip", "mcporter.json", "00-proof.png"],
      }),
    );
    expect(result).not.toContain("secret-value");
    expect(JSON.parse(result)).toEqual({
      error: "Authorization: [REDACTED]",
      artifacts: ["terminal.cast", "00-proof.png"],
    });
  });

  it.effect("sanitizes a publication tree in place and removes private state", () =>
    withTemporaryDirectory((runsDir) =>
      Effect.gen(function* () {
        const canary = `canary-${randomUUID()}`;
        const runSlug = `account-switch--${randomUUID()}`;
        const runDir = join(runsDir, "cloud", runSlug);
        mkdirSync(join(runDir, "cli-home"), { recursive: true });
        writeLaneProvenance(runDir, "cloud-hermetic", "cloud");
        writeFileSync(join(runsDir, "index.html"), "<!doctype html><title>e2e</title>");
        writeFileSync(
          join(runDir, "result.json"),
          JSON.stringify({
            scenario: "Account switch",
            target: "cloud",
            artifacts: ["terminal.cast", "trace.zip", "mcporter.json", "00-account-b.png"],
            error: `Bearer ${canary}`,
            visualEvidence: syntheticVisualEvidenceDeclaration,
          }),
        );
        writeFileSync(
          join(runDir, "terminal.cast"),
          `${JSON.stringify({ version: 2, title: canary })}\n${JSON.stringify([
            0,
            "o",
            `Open http://127.0.0.1/?_token=${canary}`,
          ])}\n`,
        );
        writeFileSync(join(runDir, "executor.log"), `authorization: Bearer ${canary}\n`);
        writeFileSync(join(runDir, "00-account-b.png"), Buffer.from("safe-image"));
        writeFileSync(join(runDir, "trace.zip"), Buffer.from(canary));
        writeFileSync(join(runDir, "mcporter.json"), JSON.stringify({ token: canary }));
        writeFileSync(join(runDir, "cli-home", "credentials.json"), canary);

        const kvmDir = join(runsDir, "desktop-kvm", "2026-06-27T00-00-00-000Z-1234");
        mkdirSync(kvmDir, { recursive: true });
        writeLaneProvenance(kvmDir, "desktop-kvm", "desktop-kvm");
        writeFileSync(
          join(kvmDir, "result.json"),
          JSON.stringify({
            scenario: "Desktop KVM account switching",
            target: "desktop-kvm",
            artifacts: ["renderer-after-settings-click.png", "session.mp4"],
            visualEvidence: syntheticVisualEvidenceDeclaration,
          }),
        );
        writeFileSync(join(kvmDir, "renderer-after-settings-click.png"), "synthetic-kvm-image");
        writeFileSync(join(kvmDir, "session.mp4"), "synthetic-kvm-video");

        yield* Effect.promise(() =>
          execute(bun, [
            sanitizer,
            "--runs-dir",
            runsDir,
            "--canary",
            canary,
            "--trusted-project",
            "cloud-hermetic",
            "--trusted-project",
            "desktop-kvm",
          ]),
        );

        expect(existsSync(join(runDir, "trace.zip"))).toBe(false);
        expect(existsSync(join(runDir, "mcporter.json"))).toBe(false);
        expect(existsSync(join(runDir, "cli-home"))).toBe(false);
        expect(existsSync(join(runDir, "00-account-b.png"))).toBe(true);
        expect(existsSync(join(kvmDir, "renderer-after-settings-click.png"))).toBe(true);
        expect(existsSync(join(kvmDir, "session.mp4"))).toBe(true);
        const result = readFileSync(join(runDir, "result.json"), "utf8");
        expect(result).not.toContain(canary);
        expect(result).not.toContain("trace.zip");
        expect(result).not.toContain("mcporter.json");
        expect(readFileSync(join(runDir, "terminal.cast"), "utf8")).not.toContain(canary);
        expect(readFileSync(join(runDir, "executor.log"), "utf8")).not.toContain(canary);
        expect(JSON.parse(readFileSync(join(runsDir, "publication.json"), "utf8"))).toMatchObject({
          schemaVersion: 1,
          status: "passed",
          policy: {
            textAndJson: "redacted",
            binaryVisuals: "unredacted-synthetic-only",
            binarySecretDetection: "byte-canary-only",
          },
          binaryArtifacts: [
            `cloud/${runSlug}/00-account-b.png`,
            "desktop-kvm/2026-06-27T00-00-00-000Z-1234/renderer-after-settings-click.png",
            "desktop-kvm/2026-06-27T00-00-00-000Z-1234/session.mp4",
          ],
        });
      }),
    ),
  );

  it.effect("fails publication if a canary remains in an allowed binary", () =>
    withTemporaryDirectory((runsDir) =>
      Effect.sync(() => {
        const canary = `binary-canary-${randomUUID()}`;
        const runDir = join(runsDir, "cloud", `binary-proof--${randomUUID()}`);
        mkdirSync(runDir, { recursive: true });
        writeLaneProvenance(runDir, "cloud-hermetic", "cloud");
        writeFileSync(
          join(runDir, "result.json"),
          JSON.stringify({
            scenario: "Binary canary",
            target: "cloud",
            artifacts: ["failure.png"],
            visualEvidence: syntheticVisualEvidenceDeclaration,
          }),
        );
        writeFileSync(join(runDir, "failure.png"), Buffer.from(canary));
        const result = spawnSync(
          bun,
          [
            sanitizer,
            "--runs-dir",
            runsDir,
            "--canary",
            canary,
            "--trusted-project",
            "cloud-hermetic",
          ],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("canary secret survived evidence sanitization");
      }),
    ),
  );

  it.effect("rejects unredacted visual evidence without a synthetic-only declaration", () =>
    withTemporaryDirectory((runsDir) =>
      Effect.sync(() => {
        const runDir = join(runsDir, "desktop", "unclassified-visual");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, "result.json"),
          JSON.stringify({ scenario: "Unclassified visual", artifacts: ["failure.png"] }),
        );
        writeFileSync(join(runDir, "failure.png"), "image-with-unknown-data-source");

        const result = spawnSync(
          bun,
          [sanitizer, "--runs-dir", runsDir, "--trusted-project", "desktop"],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("lane provenance is missing or unreadable");
        expect(existsSync(join(runDir, "failure.png"))).toBe(false);
        expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"))).toMatchObject({
          artifacts: [],
        });
        expect(JSON.parse(readFileSync(join(runsDir, "publication.json"), "utf8"))).toMatchObject({
          status: "failed",
          policy: { binaryVisuals: "unredacted-synthetic-only" },
        });
      }),
    ),
  );

  it.effect("does not let a result stamp override potentially-sensitive lane provenance", () =>
    withTemporaryDirectory((runsDir) =>
      Effect.sync(() => {
        const runDir = join(runsDir, "cloud", "live-provider-visual");
        mkdirSync(runDir, { recursive: true });
        const provenance = laneProvenanceFor("cloud", "cloud");
        expect(provenance).toBeDefined();
        writeLaneProvenance(runDir, "cloud", "cloud");
        const resultValue = {
          scenario: "Live provider visual",
          target: "cloud",
          artifacts: ["failure.png"],
          visualEvidence: syntheticVisualEvidenceDeclaration,
        };
        writeFileSync(join(runDir, "result.json"), JSON.stringify(resultValue));
        writeFileSync(join(runDir, "failure.png"), "potentially-sensitive-image");

        const decision = visualEvidencePublicationDecision(
          resultValue,
          provenance,
          "cloud",
          "cloud",
        );
        expect(decision).toMatchObject({
          publish: false,
          reason: expect.stringContaining("does not match lane classification"),
        });
        expect(
          visualEvidencePublicationDecision(
            {
              ...resultValue,
              visualEvidence: { dataClassification: "potentially-sensitive" },
            },
            provenance,
            "cloud",
            "cloud",
          ),
        ).toMatchObject({
          publish: false,
          reason: "lane cloud is potentially-sensitive",
        });
        expect(
          visualEvidencePublicationDecision(
            resultValue,
            {
              schemaVersion: 1,
              source: "e2e/src/project-matrix.ts",
              project: "cloud",
              target: "cloud",
              hermetic: true,
              dataClassification: "synthetic-only",
            },
            "cloud",
            "cloud",
          ),
        ).toMatchObject({
          publish: false,
          reason: expect.stringContaining("does not match trusted project cloud"),
        });
        expect(
          visualEvidencePublicationDecision(resultValue, provenance, "selfhost", "selfhost"),
        ).toMatchObject({
          publish: false,
          reason: expect.stringContaining("does not match trusted project"),
        });

        const result = spawnSync(
          bun,
          [sanitizer, "--runs-dir", runsDir, "--trusted-project", "cloud"],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "result visual classification synthetic-only does not match lane classification potentially-sensitive",
        );
        expect(existsSync(join(runDir, "failure.png"))).toBe(false);
      }),
    ),
  );

  it.effect("rejects a live lane that forges the hermetic project sharing its target", () =>
    withTemporaryDirectory((runsDir) =>
      Effect.sync(() => {
        const runDir = join(runsDir, "cloud", "forged-hermetic-lane");
        mkdirSync(runDir, { recursive: true });
        writeLaneProvenance(runDir, "cloud-hermetic", "cloud");
        const resultValue = {
          scenario: "Forged hermetic lane",
          target: "cloud",
          artifacts: ["failure.png"],
          visualEvidence: syntheticVisualEvidenceDeclaration,
        };
        writeFileSync(join(runDir, "result.json"), JSON.stringify(resultValue));
        writeFileSync(join(runDir, "failure.png"), "potentially-sensitive-image");
        const forged = laneProvenanceFor("cloud-hermetic", "cloud");

        expect(
          visualEvidencePublicationDecision(resultValue, forged, "cloud", "cloud"),
        ).toMatchObject({
          publish: false,
          reason: expect.stringContaining("does not match trusted project cloud"),
        });

        const result = spawnSync(
          bun,
          [sanitizer, "--runs-dir", runsDir, "--trusted-project", "cloud"],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "lane provenance does not match trusted project cloud: cloud/forged-hermetic-lane",
        );
        expect(existsSync(join(runDir, "failure.png"))).toBe(false);
      }),
    ),
  );
});

describe("e2e evidence writers", () => {
  it.effect(
    "keeps a long synchronous owner alive with an independent heartbeat",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const lockFile = join(directory, "heartbeat.json");
          const enteredFile = join(directory, "first-entered");
          const firstResult = join(directory, "first.json");
          const secondResult = join(directory, "second.json");
          const childEnv = {
            ...process.env,
            E2E_ARTIFACT_LOCK_STALE_MS: "80",
            E2E_ARTIFACT_LOCK_TIMEOUT_MS: "3000",
          };
          const worker = (resultFile: string, holdMs: number, enteredMarker?: string) => `
            import { writeFileSync } from "node:fs";
            import { withArtifactLockSync } from ${JSON.stringify(artifactModule)};
            const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            let enteredAt = 0;
            let exitedAt = 0;
            withArtifactLockSync(${JSON.stringify(lockFile)}, () => {
              enteredAt = Date.now();
              ${enteredMarker ? `writeFileSync(${JSON.stringify(enteredMarker)}, "entered");` : ""}
              Atomics.wait(sleeper, 0, 0, ${holdMs});
              exitedAt = Date.now();
            });
            writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ enteredAt, exitedAt }));
          `;

          const first = execute(bun, ["--eval", worker(firstResult, 650, enteredFile)], {
            env: childEnv,
          });
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 2_000;
            while (!existsSync(enteredFile)) {
              if (Date.now() >= deadline) throw new Error("first lock owner never entered");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await new Promise((resolve) => setTimeout(resolve, 180));
          });
          const second = execute(bun, ["--eval", worker(secondResult, 10)], { env: childEnv });
          yield* Effect.promise(() => Promise.all([first, second]));

          const firstInterval = JSON.parse(readFileSync(firstResult, "utf8")) as {
            enteredAt: number;
            exitedAt: number;
          };
          const secondInterval = JSON.parse(readFileSync(secondResult, "utf8")) as {
            enteredAt: number;
            exitedAt: number;
          };
          expect(secondInterval.enteredAt).toBeGreaterThanOrEqual(firstInterval.exitedAt);
        }),
      ),
    { timeout: 10_000 },
  );

  it.effect(
    "does not reclaim a live owner when its heartbeat is stale",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const lockFile = join(directory, "live-owner.json");
          const lockDir = `${lockFile}.lock`;
          const readyFile = join(directory, "live-owner-ready");
          const ownerResult = join(directory, "live-owner-result.json");
          const contenderResult = join(directory, "live-owner-contender.json");
          const owner = execute(bun, [
            "--eval",
            `
              import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
              const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
              const lockDir = ${JSON.stringify(lockDir)};
              mkdirSync(lockDir);
              writeFileSync(
                lockDir + "/owner",
                JSON.stringify({ schemaVersion: 1, token: "live-stalled-owner", pid: process.pid }),
              );
              const heartbeat = lockDir + "/heartbeat";
              writeFileSync(heartbeat, "live-stalled-owner");
              const staleTime = new Date(Date.now() - 10_000);
              utimesSync(heartbeat, staleTime, staleTime);
              writeFileSync(${JSON.stringify(readyFile)}, "ready");
              Atomics.wait(sleeper, 0, 0, 500);
              writeFileSync(${JSON.stringify(ownerResult)}, JSON.stringify({ exitedAt: Date.now() }));
            `,
          ]);
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 2_000;
            while (!existsSync(readyFile)) {
              if (Date.now() >= deadline) throw new Error("live owner never became ready");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          });

          const contender = execute(
            bun,
            [
              "--eval",
              `
                import { writeFileSync } from "node:fs";
                import { withArtifactLockSync } from ${JSON.stringify(artifactModule)};
                let enteredAt = 0;
                withArtifactLockSync(${JSON.stringify(lockFile)}, () => {
                  enteredAt = Date.now();
                });
                writeFileSync(${JSON.stringify(contenderResult)}, JSON.stringify({ enteredAt }));
              `,
            ],
            {
              env: {
                ...process.env,
                E2E_ARTIFACT_LOCK_STALE_MS: "80",
                E2E_ARTIFACT_LOCK_TIMEOUT_MS: "3000",
              },
            },
          );
          yield* Effect.promise(() => Promise.all([owner, contender]));

          const { exitedAt } = JSON.parse(readFileSync(ownerResult, "utf8")) as {
            exitedAt: number;
          };
          const { enteredAt } = JSON.parse(readFileSync(contenderResult, "utf8")) as {
            enteredAt: number;
          };
          expect(enteredAt).toBeGreaterThanOrEqual(exitedAt);
        }),
      ),
    { timeout: 10_000 },
  );

  it.effect(
    "recovers one stale owner without admitting overlapping contenders",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const lockFile = join(directory, "stale.json");
          const lockDir = `${lockFile}.lock`;
          mkdirSync(lockDir);
          writeFileSync(join(lockDir, "owner"), "stale-owner");
          const heartbeat = join(lockDir, "heartbeat");
          writeFileSync(heartbeat, "stale-owner");
          const staleTime = new Date(Date.now() - 10_000);
          utimesSync(heartbeat, staleTime, staleTime);

          const childEnv = {
            ...process.env,
            E2E_ARTIFACT_LOCK_STALE_MS: "80",
            E2E_ARTIFACT_LOCK_TIMEOUT_MS: "5000",
          };
          const resultFiles = Array.from({ length: 8 }, (_, index) =>
            join(directory, `contender-${index}.json`),
          );
          yield* Effect.promise(() =>
            Promise.all(
              resultFiles.map((resultFile) =>
                execute(
                  bun,
                  [
                    "--eval",
                    `
                      import { writeFileSync } from "node:fs";
                      import { withArtifactLockSync } from ${JSON.stringify(artifactModule)};
                      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
                      let enteredAt = 0;
                      let exitedAt = 0;
                      withArtifactLockSync(${JSON.stringify(lockFile)}, () => {
                        enteredAt = Date.now();
                        Atomics.wait(sleeper, 0, 0, 35);
                        exitedAt = Date.now();
                      });
                      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ enteredAt, exitedAt }));
                    `,
                  ],
                  { env: childEnv },
                ),
              ),
            ),
          );

          const intervals = resultFiles
            .map(
              (resultFile) =>
                JSON.parse(readFileSync(resultFile, "utf8")) as {
                  enteredAt: number;
                  exitedAt: number;
                },
            )
            .sort((left, right) => left.enteredAt - right.enteredAt);
          for (let index = 1; index < intervals.length; index += 1) {
            expect(intervals[index]!.enteredAt).toBeGreaterThanOrEqual(
              intervals[index - 1]!.exitedAt,
            );
          }
          expect(
            readdirSync(directory).filter((name) =>
              name.startsWith("stale.json.lock.tombstone-stale-owner-"),
            ),
          ).toHaveLength(1);
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect("archives an abandoned recovery fence before admitting the next owner", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const lockFile = join(directory, "abandoned-recovery.json");
        const lockDir = `${lockFile}.lock`;
        const recoveryDir = `${lockDir}.reclaim-stale-owner`;
        mkdirSync(join(recoveryDir, "lock"), { recursive: true });
        writeFileSync(join(recoveryDir, "owner"), "abandoned-reclaimer");
        const recoveryHeartbeat = join(recoveryDir, "heartbeat");
        writeFileSync(recoveryHeartbeat, "abandoned-reclaimer");
        writeFileSync(join(recoveryDir, "lock", "owner"), "stale-owner");
        writeFileSync(join(recoveryDir, "lock", "heartbeat"), "stale-owner");
        const staleTime = new Date(Date.now() - 10_000);
        utimesSync(recoveryHeartbeat, staleTime, staleTime);

        const resultFile = join(directory, "success.json");
        yield* Effect.promise(() =>
          execute(
            bun,
            [
              "--eval",
              `
                import { writeFileSync } from "node:fs";
                import { withArtifactLockSync } from ${JSON.stringify(artifactModule)};
                withArtifactLockSync(${JSON.stringify(lockFile)}, () => {
                  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ entered: true }));
                });
              `,
            ],
            {
              env: {
                ...process.env,
                E2E_ARTIFACT_LOCK_STALE_MS: "80",
                E2E_ARTIFACT_LOCK_TIMEOUT_MS: "3000",
              },
            },
          ),
        );

        expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ entered: true });
        expect(
          readdirSync(directory).some((name) =>
            name.startsWith("abandoned-recovery.json.lock.tombstone-recovery-abandoned-reclaimer-"),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect(
    "preserves every trace and navigation from concurrent worker processes",
    () =>
      withTemporaryDirectory((runDir) =>
        Effect.gen(function* () {
          const workers = 8;
          const entriesPerWorker = 12;
          const scripts = Array.from(
            { length: workers },
            (_, worker) => `
            import { appendTraces } from ${JSON.stringify(traceModule)};
            import { markNavigation } from ${JSON.stringify(timelineModule)};
            const runDir = ${JSON.stringify(runDir)};
            for (let index = 0; index < ${entriesPerWorker}; index += 1) {
              appendTraces(runDir, [{
                id: String(${worker}).padStart(2, "0") + String(index).padStart(30, "0"),
                at: ${worker * entriesPerWorker} + index,
                url: "http://localhost/api?token=worker-secret-${worker}",
              }]);
            }
            markNavigation(runDir, "http://localhost/worker/${worker}?code=worker-secret-${worker}");
          `,
          );
          yield* Effect.all(
            scripts.map((script) => Effect.promise(() => execute(bun, ["--eval", script]))),
            { concurrency: "unbounded" },
          );

          const traces = JSON.parse(readFileSync(join(runDir, "traces.json"), "utf8")) as Array<{
            attemptId: string;
            invocationId: string;
            sequence: number;
            url: string;
          }>;
          expect(traces).toHaveLength(workers * entriesPerWorker);
          expect(new Set(traces.map((entry) => entry.sequence)).size).toBe(traces.length);
          expect(new Set(traces.map((entry) => entry.attemptId)).size).toBe(1);
          expect(new Set(traces.map((entry) => entry.invocationId)).size).toBe(workers);
          expect(traces.map((entry) => entry.url).join("\n")).not.toContain("worker-secret");

          const timeline = JSON.parse(readFileSync(join(runDir, "timeline.json"), "utf8")) as {
            evidence: { attemptId: string; invocationIds: string[] };
            nav: Array<{ url: string }>;
          };
          expect(timeline.nav).toHaveLength(workers);
          expect(new Set(timeline.evidence.invocationIds).size).toBe(workers);
          expect(timeline.nav.map((entry) => entry.url).join("\n")).not.toContain("worker-secret");
        }),
      ),
    { timeout: 30_000 },
  );
});

describe("e2e port claims", () => {
  it.effect("keeps shared block locks until the last claim and relocates offset conflicts", () => {
    const suffix = randomUUID().replaceAll("-", "").toUpperCase();
    const envA = `E2E_HARNESS_${suffix}_A`;
    const envB = `E2E_HARNESS_${suffix}_B`;
    const envC = `E2E_HARNESS_${suffix}_C`;
    const envD = `E2E_HARNESS_${suffix}_D`;

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* Effect.acquireRelease(
            Effect.promise(() => claimPorts([{ envVar: envA, offset: 6, label: "harness-a" }])),
            (claim) => Effect.promise(() => claim.release()),
          );
          const b = yield* Effect.acquireRelease(
            Effect.promise(() => claimPorts([{ envVar: envB, offset: 7, label: "harness-b" }])),
            (claim) => Effect.promise(() => claim.release()),
          );
          expect(Math.floor(a.ports[envA]! / 10)).toBe(Math.floor(b.ports[envB]! / 10));

          yield* Effect.promise(() => a.release());
          const c = yield* Effect.acquireRelease(
            Effect.promise(() => claimPorts([{ envVar: envC, offset: 6, label: "harness-c" }])),
            (claim) => Effect.promise(() => claim.release()),
          );
          expect(Math.floor(c.ports[envC]! / 10)).toBe(Math.floor(b.ports[envB]! / 10));

          const d = yield* Effect.acquireRelease(
            Effect.promise(() => claimPorts([{ envVar: envD, offset: 7, label: "harness-d" }])),
            (claim) => Effect.promise(() => claim.release()),
          );
          expect(Math.floor(d.ports[envD]! / 10)).not.toBe(Math.floor(b.ports[envB]! / 10));
        }),
      );

      expect(process.env[envA]).toBeUndefined();
      expect(process.env[envB]).toBeUndefined();
      expect(process.env[envC]).toBeUndefined();
      expect(process.env[envD]).toBeUndefined();
    });
  });
});
