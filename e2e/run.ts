/** CLI composition root: Effect owns server processes, Vitest, evidence export and target isolation. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Clock,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { patternForTarget, scenariosForSuite } from "./test-plan.ts";
import { collectEvidence, writeEvidenceReport } from "./evidence-reporter.ts";
import { type EvidenceReport, type RunMetadata } from "./report-model.ts";
import { BrowserDriver } from "./support/browser.ts";
import { SessionClients } from "./support/api.ts";
import { provisionSelfHostActors } from "./support/actors.ts";
import { provisionCloudActors } from "./support/actors.ts";
import { startCloudEnvironment } from "./support/cloud-environment.ts";
import { startManagedServer } from "./support/managed-server.ts";
import { Target, driver, RecordingPaceMs } from "./support/platform.ts";

class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", { message: Schema.String }) {}
const freePort = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer()),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    return yield* driver(
      "allocate isolated port",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No test port"));
            else resolve(address.port);
          });
        }),
    );
  }),
);
const CloudOrigin = Schema.String.check(
  Schema.makeFilter(
    (text) => {
      const url = URL.parse(text);
      return (
        url !== null &&
        url.origin === text &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
      );
    },
    { message: "Set E2E_CLOUD_URL to the exact test stage origin." },
  ),
);
const command = Command.make("e2e", {
  target: Flag.Literals("target", ["self-host", "local", "cloud", "all", "hosted"]).pipe(
    Flag.withDefault("self-host"),
  ),
  name: Flag.String("test-name").pipe(Flag.withDefault("")),
}).pipe(
  Command.withHandler(({ target: selected, name }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const targets =
          selected === "all"
            ? (["self-host", "local", "cloud"] as const)
            : selected === "hosted"
              ? (["self-host", "cloud"] as const)
              : [selected];
        const cloud = targets.includes("cloud")
          ? yield* Config.String("E2E_CLOUD_URL").pipe(
              Config.option,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none<string>()),
                  onSome: (origin) =>
                    Schema.decodeUnknownEffect(CloudOrigin)(origin).pipe(Effect.map(Option.some)),
                }),
              ),
            )
          : Option.none<string>();
        const actors = yield* Config.String("E2E_CLOUD_ACTORS").pipe(Config.withDefault(""));
        const rows = yield* Config.Number("E2E_ROWS").pipe(Config.withDefault(1000));
        const interactive = yield* Config.Boolean("E2E_INTERACTIVE").pipe(
          Config.withDefault(false),
        );
        const observeUI = yield* Config.Boolean("E2E_UI_OBSERVE").pipe(Config.withDefault(false));
        if (observeUI && (selected !== "cloud" || Option.isSome(cloud)))
          return yield* new RunFailed({
            message:
              "UI observation is currently a managed Cloud development exploration. Use --target cloud without E2E_CLOUD_URL.",
          });
        const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));
        const recordingPaceMs = yield* Config.Number("E2E_RECORDING_PACE_MS").pipe(
          Config.withDefault(ci ? 0 : 500),
          Effect.flatMap(Schema.decodeUnknownEffect(RecordingPaceMs)),
        );
        yield* Console.log(
          recordingPaceMs === 0
            ? "No recording action pacing."
            : `Recording with ${recordingPaceMs}ms action pacing and ${recordingPaceMs * 2}ms reading pauses.`,
        );
        if (observeUI)
          yield* Console.log(
            "Storyboard capture enabled: API requests and driver actions wait for state screenshots. Timings include capture holds.",
          );
        const root = path.resolve(
          ".local/e2e",
          `${new Date().toISOString().replaceAll(":", "-")}-${selected}`,
        );
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
        const commit = (yield* processes.string(
          ChildProcess.make("git", ["rev-parse", "HEAD"]),
        )).trim();
        const dirty =
          (yield* processes.string(ChildProcess.make("git", ["status", "--porcelain"]))).trim()
            .length > 0;
        const startedAt = new Date().toISOString();
        const cloudMode = Option.isSome(cloud) ? "attached" : "managed";
        const plan = scenariosForSuite(selected === "hosted" ? "hosted" : "all", cloudMode);
        const captures = yield* Effect.forEach(
          targets,
          (target) =>
            Effect.scoped(
              Effect.gen(function* () {
                const directory = path.join(root, target);
                yield* fs.makeDirectory(`${directory}/report`, { recursive: true, mode: 0o700 });
                const managedCloud = target === "cloud" && Option.isNone(cloud);
                const origin =
                  target === "cloud"
                    ? Option.isSome(cloud)
                      ? cloud.value
                      : `http://localhost:${yield* freePort}`
                    : `http://127.0.0.1:${yield* freePort}`;
                const metadata: typeof RunMetadata.Type = {
                  target,
                  origin,
                  mode: target === "cloud" && !managedCloud ? "attached" : "managed",
                  runtime:
                    target === "cloud"
                      ? managedCloud
                        ? "Local Cloud Worker + Postgres · no saved credentials"
                        : "Cloud endpoint"
                      : "Node + PGlite",
                  commit,
                  dirty,
                  startedAt,
                  interactive,
                  diagnostics: "diagnostics/index.html",
                };
                const apiKey = Redacted.make(randomBytes(32).toString("hex"));
                const config = Target.of({
                  metadata,
                  directory,
                  apiKey,
                  cloudActors: actors || undefined,
                  rows,
                  recordingPaceMs,
                  observeUI,
                });
                yield* fs.writeFileString(
                  `${directory}/run.json`,
                  JSON.stringify(metadata, null, 2),
                );
                yield* Console.log(`Testing ${target}: ${origin}`);
                const code = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const environment = managedCloud
                      ? yield* startCloudEnvironment({
                          directory,
                          origin,
                          apiPort: yield* freePort,
                          appPort: yield* freePort,
                          databasePort: yield* freePort,
                          commit,
                          observeUI,
                        })
                      : undefined;
                    const controlOrigin =
                      target === "cloud" ? undefined : yield* startManagedServer(config);
                    if (target === "self-host" || managedCloud) {
                      yield* Effect.gen(function* () {
                        const actors = yield* environment !== undefined
                          ? provisionCloudActors
                          : provisionSelfHostActors;
                        yield* fs.writeFileString(
                          `${directory}/actors.json`,
                          JSON.stringify({
                            origin,
                            organization: actors.organization,
                            owner: Redacted.value(yield* actors.owner.cookies),
                            admin: Redacted.value(yield* actors.admin.cookies),
                            member: Redacted.value(yield* actors.member.cookies),
                          }),
                          { mode: 0o600 },
                        );
                      }).pipe(
                        Effect.provide(SessionClients.layer),
                        Effect.provideService(Target, config),
                      );
                    }
                    return yield* processes.exitCode(
                      ChildProcess.make(
                        "node",
                        [
                          "node_modules/vitest/vitest.mjs",
                          "run",
                          "--config",
                          "e2e/vitest.config.ts",
                          "--testNamePattern",
                          patternForTarget(
                            target,
                            selected === "hosted" ? "hosted" : "all",
                            name,
                            cloudMode,
                          ),
                        ],
                        {
                          extendEnv: target !== "cloud",
                          env: {
                            PATH: process.env.PATH ?? "",
                            ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
                            ...(process.env.TMPDIR === undefined
                              ? {}
                              : { TMPDIR: process.env.TMPDIR }),
                            ...(process.env.E2E_CLAUDE_BASE_URL === undefined
                              ? {}
                              : { E2E_CLAUDE_BASE_URL: process.env.E2E_CLAUDE_BASE_URL }),
                            ...(process.env.E2E_CLAUDE_API_KEY === undefined
                              ? {}
                              : { E2E_CLAUDE_API_KEY: process.env.E2E_CLAUDE_API_KEY }),
                            ...(environment === undefined
                              ? process.env.E2E_EMULATORS === undefined
                                ? {}
                                : { E2E_EMULATORS: process.env.E2E_EMULATORS }
                              : { E2E_EMULATORS: environment.emulators }),
                            ...(process.env.E2E_WORKFLOW_HOLD_MS === undefined
                              ? {}
                              : { E2E_WORKFLOW_HOLD_MS: process.env.E2E_WORKFLOW_HOLD_MS }),
                            E2E_TARGET: target,
                            E2E_CLOUD_MODE: cloudMode,
                            EXECUTOR_E2E_RUN: directory,
                            EXECUTOR_E2E_API_KEY: Redacted.value(apiKey),
                            EXECUTOR_E2E_CONTROL_ORIGIN: controlOrigin ?? "",
                            E2E_CLOUD_ACTORS: actors,
                            ...(process.env.E2E_AXIOM_TOKEN === undefined
                              ? {}
                              : { E2E_AXIOM_TOKEN: process.env.E2E_AXIOM_TOKEN }),
                            ...(process.env.E2E_AXIOM_DATASET === undefined
                              ? {}
                              : { E2E_AXIOM_DATASET: process.env.E2E_AXIOM_DATASET }),
                            ...(process.env.E2E_AXIOM_ORG_ID === undefined
                              ? {}
                              : { E2E_AXIOM_ORG_ID: process.env.E2E_AXIOM_ORG_ID }),
                            E2E_SUITE: selected === "hosted" ? "hosted" : "all",
                            E2E_INTERACTIVE: interactive ? "1" : "0",
                            E2E_UI_OBSERVE: observeUI ? "1" : "0",
                            E2E_RECORDING_PACE_MS: String(recordingPaceMs),
                          },
                          stdout: "inherit",
                          stderr: "inherit",
                        },
                      ),
                    );
                  }),
                );
                return { target, code, config, directory };
              }),
            ),
          { concurrency: selected === "all" ? 3 : 2 },
        );
        // No encoding runs while another target is still exercising the application.
        yield* Console.log("All test targets finished. Rendering evidence outside test timing…");
        const results = yield* Effect.forEach(captures, ({ target, code, config, directory }) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const entries = yield* collectEvidence(directory).pipe(
              Effect.provide(BrowserDriver.layer),
              Effect.provideService(Target, config),
            );
            const report = { runs: [config.metadata], entries, plan };
            yield* writeEvidenceReport(`${directory}/report`, report);
            const ended = yield* Clock.currentTimeMillis;
            yield* Console.log(
              `${target}: evidence processing ${((ended - started) / 1000).toFixed(1)}s (excluded from test durations)`,
            );
            return { target, code, report, directory };
          }),
        );
        const output = path.join(root, "report");
        yield* fs.makeDirectory(`${output}/targets`, { recursive: true });
        for (const result of results)
          yield* fs.copy(`${result.directory}/report`, `${output}/targets/${result.target}`);
        const report: EvidenceReport = {
          plan,
          runs: results.flatMap(({ target, report }) =>
            report.runs.map((run) => ({
              ...run,
              diagnostics: `targets/${target}/${run.diagnostics}`,
            })),
          ),
          entries: results.flatMap(({ target, report }) =>
            report.entries.map((entry) => ({
              ...entry,
              attachments: entry.attachments.map((item) => ({
                ...item,
                href: `targets/${target}/${item.href}`,
              })),
            })),
          ),
        };
        yield* writeEvidenceReport(output, report);
        yield* Console.log(`Test evidence: ${output}/index.html`);
        if (results.some((result) => result.report.entries.length === 0))
          return yield* new RunFailed({
            message: "No scenarios produced evidence for a selected target. Check the test filter.",
          });
        if (results.some((result) => result.code !== 0))
          return yield* new RunFailed({
            message: "One or more targets failed. Their evidence is retained.",
          });
      }),
    ),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
