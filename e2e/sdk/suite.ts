/** CLI composition root: Effect owns server processes, Vitest, raw evidence and target isolation. */
import { Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import {
  patternForTarget,
  scenariosForSuite,
  type CloudMode,
  type TestPlan,
} from "../test-plan.ts";
import { readEvidence, combineEvidenceReports } from "../evidence-results.ts";
import { type EvidenceReport, type RunMetadata } from "../report-model.ts";
import { startCloudEnvironment } from "../support/cloud-environment.ts";
import { localNpmRegistry } from "../support/npm-registry.ts";
import { type FixtureControl, fixtureControlEnvironment } from "./fixtures.ts";
import { RecordingPaceMs, Target } from "../support/platform.ts";
import { roleHost } from "../support/role-hosts.ts";
import { prepareCloudScenarios } from "./prepare-scenarios.ts";

class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", { message: Schema.String }) {}
import { freePort } from "../support/ports.ts";

/**
 * Managed Cloud workers share one local Cloud Worker and one telemetry collector, so more cores add
 * no capacity. On a 16-vCPU runner, eight workers left 12 cores idle and finished no sooner than
 * six, but doubled the Worker's `/health` p95, tripled the collector's refused exports and took a
 * 19-second scenario to 49 seconds.
 */
const sharedCloudWorkers = 6;
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
/** Run committed scenarios against managed products or an explicitly attached Cloud environment. */
export const runSuite = ({
  target: selected,
  name = "",
  workers,
  defaultWorkers = 16,
  authRateLimit = false,
  rollback = false,
  oauthProxyPreview = false,
  attachment,
}: {
  readonly target: "self-host" | "local" | "cloud" | "all" | "hosted";
  readonly name?: string;
  /** Files run at once on every target. Overrides `defaultWorkers` and the managed Cloud cap. */
  readonly workers?: number | undefined;
  /** Files run at once when `workers` is unset. Managed local Cloud runs at most six. */
  readonly defaultWorkers?: number;
  /** Start managed Cloud with the per-address auth limit on, for the scenarios that prove it. */
  readonly authRateLimit?: boolean;
  /**
   * Start managed Cloud with `CLOUD_BROWSER_ORIGIN=deployment`, the rollback switch, for the
   * scenarios that prove it.
   */
  readonly rollback?: boolean;
  /**
   * Start a second managed Cloud as the OAuth proxy's production, and run against a test stage that
   * signs in through it, for the scenarios that prove the proxy.
   */
  readonly oauthProxyPreview?: boolean;
  readonly attachment?: {
    readonly origin: string;
    readonly fixtures: typeof FixtureControl.Type;
    readonly emulators: string;
    readonly appUiBaseUrl?: string;
    readonly axiom?: {
      readonly token: Redacted.Redacted<string>;
      readonly organization: string;
      readonly dataset: string;
    };
  };
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
      )(workers ?? defaultWorkers);
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
        Config.option,
      );
      const runtimePath = yield* Config.String("EXECUTOR_E2E_RUNTIME_PATH").pipe(Config.option);
      const targets =
        selected === "all"
          ? (["self-host", "local", "cloud"] as const)
          : selected === "hosted"
            ? (["self-host", "cloud"] as const)
            : [selected];
      const cloud =
        attachment !== undefined
          ? Option.some(attachment.origin)
          : targets.includes("cloud")
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
      if (authRateLimit && (selected !== "cloud" || Option.isSome(cloud)))
        return yield* new RunFailed({
          message:
            "The auth rate limit can be turned on only for managed Cloud. Use --target cloud without E2E_CLOUD_URL.",
        });
      if (rollback && (authRateLimit || selected !== "cloud" || Option.isSome(cloud)))
        return yield* new RunFailed({
          message:
            "The rollback switch can be turned on only for managed Cloud, without --auth-rate-limit. Use --target cloud without E2E_CLOUD_URL.",
        });
      if (
        oauthProxyPreview &&
        (authRateLimit || rollback || selected !== "cloud" || Option.isSome(cloud))
      )
        return yield* new RunFailed({
          message:
            "The OAuth proxy preview runs only on managed Cloud, without --auth-rate-limit or --rollback. Use --target cloud without E2E_CLOUD_URL.",
        });
      const interactive = yield* Config.Boolean("E2E_INTERACTIVE").pipe(Config.withDefault(false));
      const observeUI = yield* Config.Boolean("E2E_UI_OBSERVE").pipe(Config.withDefault(false));
      if (observeUI && (selected !== "cloud" || Option.isSome(cloud)))
        return yield* new RunFailed({
          message:
            "UI observation is currently a managed Cloud development exploration. Use --target cloud without E2E_CLOUD_URL.",
        });
      const recordingPaceMs = yield* Config.Number("E2E_RECORDING_PACE_MS").pipe(
        Config.withDefault(0),
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
        `${new Date().toISOString().replaceAll(":", "-")}-${selected}-${randomBytes(3).toString("hex")}`,
      );
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      const commit = (yield* processes.string(
        ChildProcess.make("git", ["rev-parse", "HEAD"]),
      )).trim();
      const dirty =
        (yield* processes.string(ChildProcess.make("git", ["status", "--porcelain"]))).trim()
          .length > 0;
      const startedAt = new Date().toISOString();
      const cloudMode: CloudMode = Option.isSome(cloud)
        ? "attached"
        : authRateLimit
          ? "rate-limited"
          : rollback
            ? "rolled-back"
            : oauthProxyPreview
              ? "oauth-proxy-preview"
              : "managed";
      const plan = scenariosForSuite(selected === "hosted" ? "hosted" : "all", cloudMode);
      const filter = yield* Effect.try({
        try: () => new RegExp(name),
        catch: () =>
          new RunFailed({ message: "The test-name filter is not a valid regular expression." }),
      });
      const empty = targets.filter(
        (target) =>
          !plan.some(
            (scenario) =>
              scenario.targets[target].status === "scheduled" && filter.test(scenario.title),
          ),
      );
      if (empty.length > 0)
        return yield* new RunFailed({
          message: `No scheduled scenarios match for ${empty.join(", ")}. Check the test-name filter.`,
        });
      const captures = yield* Effect.forEach(
        targets,
        (target) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = path.join(root, target);
              yield* fs.makeDirectory(`${directory}/report`, { recursive: true, mode: 0o700 });
              const managedCloud = target === "cloud" && Option.isNone(cloud);
              const targetWorkers =
                workers ??
                (managedCloud ? Math.min(defaultWorkers, sharedCloudWorkers) : defaultWorkers);
              const origin =
                target === "cloud"
                  ? Option.isSome(cloud)
                    ? cloud.value
                    : `http://localhost:${yield* freePort}`
                  : `http://127.0.0.1:${yield* freePort}`;
              // The OAuth proxy's production, beside the test stage this run tests.
              const proxyProduction =
                managedCloud && oauthProxyPreview
                  ? Option.some(`http://localhost:${yield* freePort}`)
                  : Option.none<string>();
              const metadata: typeof RunMetadata.Type = {
                target,
                origin,
                mode: target === "cloud" && !managedCloud ? "attached" : "managed",
                runtime:
                  target === "cloud"
                    ? managedCloud
                      ? `Local Cloud Worker + Postgres · no saved credentials · auth rate limit ${authRateLimit ? "on" : "off"}${rollback ? " · sign-in on the deployment origin" : ""}${oauthProxyPreview ? " · a test stage signing in through a second local Cloud's OAuth proxy" : ""}`
                      : "Cloud endpoint"
                    : target === "local" && Option.isSome(packagedEntry)
                      ? "Installed npm CLI + PGlite per scenario"
                      : "Node + PGlite per scenario",
                commit,
                dirty,
                startedAt,
                interactive,
                diagnostics: "diagnostics/results.json",
                ...(target === "cloud" && rollback ? { browserOrigin: "deployment" as const } : {}),
                ...Option.match(proxyProduction, {
                  onNone: () => ({}),
                  onSome: (production) => ({ oauthProxyProduction: production }),
                }),
              };
              const apiKey = Redacted.make(randomBytes(32).toString("hex"));
              yield* fs.writeFileString(`${directory}/run.json`, JSON.stringify(metadata, null, 2));
              yield* Console.log(
                `Testing ${target}: ${target === "cloud" ? origin : target === "local" && Option.isSome(packagedEntry) ? `installed CLI at ${packagedEntry.value}` : "isolated server per scenario"} · ${interactive || observeUI ? 1 : targetWorkers} workers`,
              );
              const code = yield* Effect.scoped(
                Effect.gen(function* () {
                  // Products this run starts build apps against the checkout's own apps release.
                  const registry =
                    target === "cloud" && !managedCloud ? undefined : yield* localNpmRegistry;
                  // Production trusts the stage's browser origin, which it returns profiles to.
                  const productionDirectory = path.join(directory, "oauth-proxy-production");
                  if (Option.isSome(proxyProduction))
                    yield* fs.makeDirectory(productionDirectory, { recursive: true, mode: 0o700 });
                  const production = Option.isSome(proxyProduction)
                    ? Option.some(
                        yield* startCloudEnvironment({
                          ...(registry === undefined ? {} : { npmRegistry: registry.url }),
                          directory: productionDirectory,
                          origin: proxyProduction.value,
                          appPort: yield* freePort,
                          databasePort: yield* freePort,
                          commit,
                          observeUI: false,
                          authRateLimit: false,
                          browserOrigin: "app",
                          trustedOrigins: [roleHost(origin, "app")],
                        }),
                      )
                    : Option.none();
                  const environment = managedCloud
                    ? yield* startCloudEnvironment({
                        ...(registry === undefined ? {} : { npmRegistry: registry.url }),
                        directory,
                        origin,
                        appPort: yield* freePort,
                        databasePort: yield* freePort,
                        commit,
                        observeUI,
                        authRateLimit,
                        browserOrigin: rollback ? "deployment" : "app",
                        ...Option.match(production, {
                          onNone: () => ({}),
                          onSome: (production) => ({
                            signInThrough: production.oauthProxy,
                            prebuilt: true as const,
                          }),
                        }),
                      })
                    : undefined;
                  const preparedScenarios =
                    attachment?.appUiBaseUrl === undefined
                      ? {}
                      : yield* prepareCloudScenarios({
                          target: Target.of({
                            metadata,
                            directory,
                            apiKey,
                            rows: 1000,
                            recordingPaceMs,
                            observeUI,
                            fixtures: attachment.fixtures,
                          }),
                          appUiBaseUrl: attachment.appUiBaseUrl,
                          workers: targetWorkers,
                          scenarios: plan
                            .filter(
                              (scenario: typeof TestPlan.Type) =>
                                scenario.fixtures === "actors" &&
                                scenario.targets[target].status === "scheduled" &&
                                filter.test(scenario.title),
                            )
                            .map((scenario: typeof TestPlan.Type) => ({
                              title: scenario.title,
                              ...(scenario.appOrigin ? { appOrigin: true as const } : {}),
                            })),
                        });
                  yield* fs.writeFileString(
                    `${directory}/prepared-scenarios.json`,
                    JSON.stringify(preparedScenarios, null, 2),
                  );
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
                        extendEnv: false,
                        env: {
                          PATH: process.env.PATH ?? "",
                          ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
                          ...(process.env.TMPDIR === undefined
                            ? {}
                            : { TMPDIR: process.env.TMPDIR }),
                          ...(Option.isSome(packagedEntry)
                            ? { EXECUTOR_E2E_LOCAL_ENTRY: packagedEntry.value }
                            : {}),
                          ...(Option.isSome(runtimePath)
                            ? { EXECUTOR_E2E_RUNTIME_PATH: runtimePath.value }
                            : {}),
                          ...(process.env.MCP_CACHE_FIXTURE_ORIGIN === undefined
                            ? {}
                            : { MCP_CACHE_FIXTURE_ORIGIN: process.env.MCP_CACHE_FIXTURE_ORIGIN }),
                          ...(process.env.E2E_CLAUDE_BASE_URL === undefined
                            ? {}
                            : { E2E_CLAUDE_BASE_URL: process.env.E2E_CLAUDE_BASE_URL }),
                          ...(process.env.E2E_CLAUDE_API_KEY === undefined
                            ? {}
                            : { E2E_CLAUDE_API_KEY: process.env.E2E_CLAUDE_API_KEY }),
                          ...(attachment !== undefined
                            ? { E2E_EMULATORS: attachment.emulators }
                            : environment === undefined
                              ? process.env.E2E_EMULATORS === undefined
                                ? {}
                                : { E2E_EMULATORS: process.env.E2E_EMULATORS }
                              : { E2E_EMULATORS: environment.emulators }),
                          ...(process.env.E2E_WORKFLOW_HOLD_MS === undefined
                            ? {}
                            : { E2E_WORKFLOW_HOLD_MS: process.env.E2E_WORKFLOW_HOLD_MS }),
                          E2E_PREPARED_SCENARIOS: JSON.stringify(preparedScenarios),
                          E2E_TEST_NAME: name,
                          E2E_WORKERS: String(interactive || observeUI ? 1 : targetWorkers),
                          E2E_TARGET: target,
                          E2E_CLOUD_MODE: cloudMode,
                          ...(registry === undefined ? {} : { E2E_NPM_REGISTRY: registry.url }),
                          EXECUTOR_E2E_RUN: directory,
                          EXECUTOR_E2E_API_KEY: Redacted.value(apiKey),
                          E2E_FIXTURES:
                            environment === undefined
                              ? attachment === undefined
                                ? (process.env.E2E_FIXTURES ?? "")
                                : fixtureControlEnvironment(attachment.fixtures)
                              : fixtureControlEnvironment(environment.fixtures),
                          ...(attachment?.axiom !== undefined
                            ? {
                                E2E_AXIOM_TOKEN: Redacted.value(attachment.axiom.token),
                                E2E_AXIOM_DATASET: attachment.axiom.dataset,
                                E2E_AXIOM_ORG_ID: attachment.axiom.organization,
                              }
                            : process.env.E2E_AXIOM_TOKEN === undefined
                              ? {}
                              : { E2E_AXIOM_TOKEN: process.env.E2E_AXIOM_TOKEN }),
                          ...(attachment?.axiom !== undefined ||
                          process.env.E2E_AXIOM_DATASET === undefined
                            ? {}
                            : { E2E_AXIOM_DATASET: process.env.E2E_AXIOM_DATASET }),
                          ...(attachment?.axiom !== undefined ||
                          process.env.E2E_AXIOM_ORG_ID === undefined
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
              return { target, code, metadata, directory };
            }),
          ),
        { concurrency: selected === "all" ? 3 : 2 },
      );
      const results = yield* Effect.forEach(captures, ({ target, code, metadata, directory }) =>
        Effect.gen(function* () {
          const entries = yield* readEvidence(directory);
          const report: EvidenceReport = { runs: [metadata], entries, plan };
          return { target, code, report };
        }),
      );
      const report = combineEvidenceReports(
        results.map(({ target, report }) => ({ report, prefix: `${target}/report` })),
        plan,
      );
      yield* fs.writeFileString(path.join(root, "evidence.json"), JSON.stringify(report, null, 2));
      yield* Console.log(`Raw test evidence: ${root}`);
      yield* Console.log(`Render on request: bun run e2e:render --directory ${root}`);
      if (results.some((result) => result.report.entries.length === 0))
        return yield* new RunFailed({
          message: "No scenarios produced evidence for a selected target. Check the test filter.",
        });
      if (results.some((result) => result.code !== 0))
        return yield* new RunFailed({
          message: "One or more targets failed. Their evidence is retained.",
        });
    }),
  );
