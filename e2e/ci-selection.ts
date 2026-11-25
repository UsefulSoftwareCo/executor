import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMain } from "./run-main.ts";
import {
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import { collectorChanged, collectorScenarios } from "./collector-inputs.ts";
import { lanesFor, releaseSources } from "./release-lanes.ts";
import { packagedEngineDependency } from "./packaged-engine.ts";
import { savePathFiles } from "./save-path.ts";
import { blocksIn, parseRequested, type Requested } from "./ci-block.ts";
import { fileGuards } from "./file-guards.ts";
import { broadChanges } from "./narrowing.ts";
import { selectionKey, workerGrowthKey } from "./ci-key.ts";
import { mcpSearchChanged, mcpSearchTitles } from "./mcp-search-guard.ts";
import { Target } from "./report-model.ts";
import { exactly, split, splitByCount } from "./scenario-parts.ts";
import { platformSignatures } from "./platform-signatures.ts";
import {
  connectionLatencyLevels,
  DatabaseConnections,
  databaseConnectionsFile,
} from "./database-connections.ts";
import { countEmulatorRetries, emulatorRetryLine } from "./emulator-retries.ts";
import { deployedSuitePattern, scenarios, scenariosForSuite, type CloudMode } from "./test-plan.ts";

class SelectionFailed extends Schema.TaggedError<SelectionFailed>()("SelectionFailed", {
  message: Schema.String,
}) {}

const claude = "Claude Code connects";
const inventoryLoad = "concurrent owners and admins save every account";
const catalogScale =
  "MCP execute over 7,000 tools|MCP execute beside stalled apps|MCP execute pays for a slow app|MCP execute remembers a stalled|MCP execute serves a search from rows past|MCP execute reports an app whose aged";

const harnessScenarios = {
  job: "self-host",
  files: ["failure-evidence.spec.ts", "product-port.spec.ts", "failure-text.spec.ts"],
  paths: [
    "e2e/support/",
    "e2e/sdk/",
    "e2e/failure-evidence/",
    "e2e/tests/failure-evidence.spec.ts",
    "e2e/tests/product-port.spec.ts",
    "e2e/failure-text/",
    "e2e/tests/failure-text.spec.ts",
    "e2e/setup.ts",
    "e2e/run.ts",
    "e2e/vitest.config.ts",
    "e2e/evidence-reporter.ts",
    "e2e/evidence-results.ts",
    "e2e/report-model.ts",
    "e2e/host-slot.ts",
    "e2e/ci-selection.ts",
    "package.json",
    "bun.lock",
    "patches/",
    "packages/telemetry/",
  ],
} as const;
const harnessTitles = scenariosForSuite("all")
  .filter((scenario) => (harnessScenarios.files as ReadonlyArray<string>).includes(scenario.file))
  .map((scenario) => scenario.title);
const saveScenarios = { job: "cloud-locks", files: ["webhook-source-lookup.spec.ts"] } as const;
const saveTitles = scenariosForSuite("all")
  .filter((scenario) => (saveScenarios.files as ReadonlyArray<string>).includes(scenario.file))
  .map((scenario) => scenario.title);
const harnessPattern = harnessTitles
  .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const compareFileLimit = 300;

const repeats = 4;
const repeatLimit = 60;

const jobs = {
  local: { target: "local", pattern: `^(?!.*${claude})`, shards: 3 },
  "self-host": {
    target: "self-host",
    pattern: `^(?!.*(?:${claude}|${inventoryLoad}|${catalogScale}|${harnessPattern}))`,
    shards: 12,
  },
  "self-host-inventory": { target: "self-host", pattern: inventoryLoad },
  "self-host-catalog": { target: "self-host", pattern: catalogScale },
  cloud: {
    target: "cloud",
    runner: 1,

    pattern:
      "Cloud app queries read current authorization|Cloud onboarding|Cloud OAuth callbacks|Cloud OAuth token requests record|Cloud product events|Cloud records a connection's first initialize|Cloud names the organization an agent approved|Cloud names a sign-up that started from an MCP client|Cloud feedback|Cloud tracks an unusable OAuth|app query traces|observability retains|browser failures reach error collectors|browser error reports reach Sentry while|browser telemetry stays quiet on an idle page|Browser connection failures explain|optimistic replay failures|private app crash reports|Platform admin impersonation|Cloud reports the framework pin|Cloud deploys fail promptly when the compiler does not answer|refuses every stored state Better Auth refuses|Billing reconciles only while visible|A dashboard read refreshed while in flight|Cloud finishes a slow app's tool listing|Cloud remembers a stalled tool listing|Cloud keeps serving aged search rows when it stops their renewal|Cloud MCP session objects make|Cloud MCP request spans say whether|database failure while verifying an API key|use one API key together|Cloud cron wakes the schedule coordinator|schedule coordinator closes its database connections|Cloud runs a due schedule and requested webhook source setup while|app evaluation failures explain the likely cause|runtime limit matched from an app Worker|client request rejections are recorded on their request span|failure text reaches its caller|scheduled runs record whether the app's code|an app request Executor's network failed to send|an app's fetch receives a Brotli-encoded response|MCP tool calls deliver their tool name and outcome|Executor time|Owners delete an organization with every app|Hosted MCP negotiates older protocol versions|Hosted MCP ends a cancelled call|through the Skills extension|The Skills extension serves|Cloud lists each build's browser files|Hosted dashboard runs of approval-gated tools|Hosted dashboard approval",
  },
  "cloud-product": {
    target: "cloud",
    runner: 3,

    pattern:
      "Cloud SSO SAML accepts|Cloud's operator OAuth client signs in|Cloud's own Executor for Google registration refuses|Safari reports only the page's own failures|Cloud cron triggers run their jobs|Cloud cron jobs record their outcome|Cloud support dialog lists every channel|Cloud shows every member the newest feature or improvement|Hosted feedback enforces its API contract|Executor's catalog calls an app's own cache methods|Executor app is installed with nothing left pending|Executor app's managed key|reconnected into the Executor app.s key account while its renewal commits|already bears the Executor app.s key name|A disabled Executor app key is never recreated|Cloud MCP routes a request inside a session|Cloud MCP sessions continue after their session object is evicted|Request and workflow attempts at one team|remote skill catalog|a skill read without a revision|abandons a GitHub skills load|reads its catalog and the tool in one cache command|a cold call's wake is reported by that call alone|another organization's admin cannot read the link|account connections cannot cross organizations|Deploys wake webhook source setup|Cloud's schedule coordinator keeps nine slow scheduled runs|a webhook source reconciling for an activation that another supersedes|A skill catalog refreshed in the background after a dashboard batch read|Cloud MCP session objects run parallel tool calls|Cloud MCP session objects cancel a statement|Cloud MCP session objects discover the other apps|Cloud MCP session objects' database pool|Cloud's database pool runs a statement whose connection|Hosted MCP resume reports an approved call's own failure|Cloud refuses to remove an organization while one of its app workflows runs|Removing an organization revokes the refresh token|Cloud v1 session handoff|Cloud accepts MCP requests v1 forwards|Cloud validates a v1 WorkOS API key|Hosted MCP operation and bearer-check spans name|Hosted management API request spans name only|Hosted request spans record the client, the credential|Cloud's gateway names an authenticated MCP request's organization|A person deletes their own user|Cloud invitations left pending after their inviter lost|On Cloud a slow tool call log write|A Cloud scenario's clean-up returns once its organization's removal is accepted|The end-of-run removal check answers each look within its request limit|The end-of-run removal check asks again after a dropped request|The end-of-run removal check keeps waiting for a removal recorded done|a run's sleep whose engine call failed is called again|a completed MCP app call cancels nothing|an MCP app call given up in flight|ten concurrent MCP app calls behind six connections",
  },
  "cloud-domains": {
    target: "cloud",
    runner: 5,
    pattern:
      "cloud role hosts serve only|a grant is for its one resource|role host resource seed|Cloud's edge serves v1|Cloud answers v1's AuthKit|An MCP SDK client holding AuthKit|A person approves a client for one of v1's MCP URLs|Cloud request spans name the host|Cloud sign-in explains that a passkey|Cloud connected-account sign-ins return through|Cloud serves its site for the edge|keep serving the published skills index|Apps directory on the edge reads|Cloud's API host serves the SDK|Cloud's own social sign-ins on app\\.|hosted wildcard routes trace their template|Cloud links the site's anonymous visitor",
  },
  "cloud-workers": {
    target: "cloud",
    runner: 4,

    pattern:
      "app Workers stay loaded across credential rotation|workflow runs reuse the app Worker|warm app calls load no build|Cold app Workers reuse a build|a cold app Worker receives only the modules|Cold app Workers read their build in the runner|A cold app load links its small build record|Apps on the same apps release store its framework|Builds on two apps releases each link",
  },
  "cloud-locks": {
    target: "cloud",
    runner: 4,

    pattern:
      "A Better Auth query|an app link that waits for the admin.s membership while a demotion commits|two first checks of an account that write its check row|saving an account beside 100,000 accounts, links and webhook sources",
  },
  "cloud-removal-recovery": {
    target: "cloud",
    runner: 6,
    pattern: "Cloud starts organization removals whose Workflow start stalled",
  },
  "cloud-batch": {
    target: "cloud",
    runner: 4,
    pattern: "Cloud MCP tool calls send their checks and reads",
  },
  "cloud-export-hang": {
    target: "cloud",
    runner: 6,
    pattern: "Cloud requests answer and release their database connections while the telemetry",
  },
  "cloud-listings": {
    target: "cloud",
    runner: 6,
    pattern:
      "Cloud keeps each JSON Schema definition a tool listing repeats once|definitions share a name and length but not their JSON|definition names are long and of one length|Cloud serves a tool listing its isolate cannot keep|Cloud writes the background refresh of a stale tool listing",
  },
  "cloud-autumn": {
    target: "cloud",
    runner: 4,
    pattern: "Cloud's billing overview sends one Autumn read while Autumn is slow",
  },
  "cloud-isolate": { target: "cloud", runner: 2, pattern: "Cloud MCP session objects report" },
  "cloud-telemetry-flush": {
    target: "cloud",
    runner: 2,
    pattern: "Cloud's isolate telemetry flush",
  },
  "cloud-connections": {
    target: "cloud",
    runner: 2,
    pattern: "Cloud MCP session objects hold their database connections",
  },
  "cloud-rate-limit": {
    target: "cloud",
    runner: 5,

    cloudMode: "rate-limited",
    pattern:
      "Cloud limits sign-in and OAuth client registration per address|Cloud counts two first requests from one address|Cloud reports a Better Auth query the database failed|Cloud records a rate-limited OAuth token request",
  },
  "cloud-rollback": {
    target: "cloud",
    runner: 5,
    cloudMode: "rolled-back",
    pattern:
      "Cloud's rollback switch serves sign-in|Cloud's own social sign-ins under the rollback switch",
  },
  "cloud-oauth-proxy-preview": {
    target: "cloud",
    runner: 5,
    cloudMode: "oauth-proxy-preview",
    pattern:
      "A test stage signs in through production's OAuth proxy|A test stage connects an account with production's OAuth callback",
  },
  "cloud-revocation-budget": {
    target: "cloud",
    runner: 6,
    cloudMode: "revocation-budget",
    pattern: "Removing an organization whose service never answers revocations",
  },
  "cloud-empty-release-notes": {
    target: "cloud",
    runner: 6,
    cloudMode: "empty-release-notes",
    pattern: "Cloud built with an empty notes file",
  },
  "cloud-fix-release-notes": {
    target: "cloud",
    runner: 5,
    cloudMode: "fix-release-notes",
    pattern: "Cloud built with notes that are all fixes",
  },
  "cloud-feature-release-notes": {
    target: "cloud",
    runner: 2,
    cloudMode: "feature-release-notes",
    pattern: "Cloud built with notes whose newest is a feature",
  },
} as const satisfies Record<
  string,
  | { target: "local" | "self-host"; pattern: string; shards?: number }
  | { target: "cloud"; cloudMode?: CloudMode; runner: number; pattern: string }
>;

const planFor = (job: (typeof jobs)[keyof typeof jobs]) =>
  scenariosForSuite("all", "cloudMode" in job ? job.cloudMode : "managed");
const specFiles: ReadonlySet<string> = new Set(
  scenariosForSuite("all").map((scenario) => scenario.file),
);
const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const runs = (
  plan: ReturnType<typeof scenariosForSuite>,
  target: typeof Target.Type,
  pattern: string,
): ReadonlySet<string> =>
  new Set(
    plan
      .filter(
        (scenario) =>
          scenario.targets[target].status === "scheduled" &&
          new RegExp(pattern).test(scenario.title),
      )
      .map((scenario) => scenario.title),
  );
const jobRuns = Object.entries(jobs).map(([name, job]) => ({
  name,
  target: job.target,
  titles: runs(planFor(job), job.target, job.pattern),
}));
const deployedRuns = runs(scenariosForSuite("all", "attached"), "cloud", deployedSuitePattern);
const fileOf: ReadonlyMap<string, string> = new Map(
  Object.values(scenarios).map((scenario) => [scenario.title, scenario.file]),
);
const jobFiles: ReadonlySet<string> = new Set([
  ...jobRuns.flatMap(({ titles }) => [...titles].map((title) => fileOf.get(title)!)),
  ...harnessScenarios.files,
]);
const deployedOnly = [...deployedRuns].filter((title) =>
  jobRuns.every(({ target, titles }) => target !== "cloud" || !titles.has(title)),
);
const deployedOnlyJob = "cloud-product" satisfies keyof typeof jobs;

const deployedVerification = /^Verified on a deployed stage:[ \t]*(\S.{9,})$/mu;

const namedIn = (plan: string, title: string) => plan.includes(JSON.stringify(title));
const localCloudScenarios = 30;
const managedCloud = runs(scenariosForSuite("all", "managed"), "cloud", "");

const notRunInCi: Partial<
  Record<
    keyof typeof scenarios,
    { readonly targets: ReadonlyArray<typeof Target.Type>; readonly reason: string }
  >
> = {
  mcp: {
    targets: ["self-host", "cloud"],
    reason: "Needs a model API key, which CI does not hold.",
  },
  localMcp: { targets: ["local"], reason: "Needs a model API key, which CI does not hold." },
  cloudSsoOidc: {
    targets: ["cloud"],
    reason:
      "Fails on managed local Cloud: times out at 60 s (https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37728676598).",
  },
  dynamicSkills: {
    targets: ["cloud"],
    reason:
      "Fails on managed local Cloud: the Skills tab says the app source could not be saved or loaded (https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37728676598).",
  },
  serverRenderedSkills: {
    targets: ["cloud"],
    reason:
      "Fails on managed local Cloud: the Skills tab says the app source could not be saved or loaded (https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37728676598).",
  },
  appWorkerAttribution: {
    targets: ["cloud"],
    reason:
      "Fails on managed local Cloud: no attributed invocation arrives (https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37728676598).",
  },
  browserErrorProvenance: {
    targets: ["cloud"],
    reason:
      "Flaky on managed local Cloud: the dashboard sometimes renders without the resource read it breaks, so no Retry appears (passed in https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37728676598, failed in https://github.com/UsefulSoftwareCo/executor-next/actions/runs/37729728401).",
  },
  cloudCompilerMemory: {
    targets: ["cloud"],
    reason:
      "Exhausting the shared compiler can interrupt other scenarios' builds, so it runs alone, by hand: bun run e2e:deployed --test-name 'Cloud compiler memory failures' --workers 1.",
  },
};

const ciRuns = (title: string, target: typeof Target.Type) => [
  ...(harnessTitles.includes(title) && target === jobs[harnessScenarios.job].target
    ? [`the ${harnessScenarios.job} job when the harness changes`]
    : []),
  ...jobRuns
    .filter((job) => job.target === target && job.titles.has(title))
    .map(({ name }) => `the ${name} job`),
  ...(target === "cloud" && deployedRuns.has(title) ? ["Cloud tests on main"] : []),
];

const coverageProblems = () => {
  const problems: Array<string> = [];
  for (const [key, scenario] of Object.entries(scenarios)) {
    const exception = notRunInCi[key as keyof typeof scenarios];
    for (const target of ["local", "self-host", "cloud"] as const) {
      const excepted = exception?.targets.includes(target) === true;
      const scheduled = scenario.targets[target].status === "scheduled";
      const paths = scheduled ? ciRuns(scenario.title, target) : [];
      const where = `scenarios.${key} (${scenario.file}) on ${target}`;
      if (scheduled && paths.length === 0 && !excepted)
        problems.push(`- ${where}: "${scenario.title}" is scheduled, but no CI job runs it.`);
      else if (excepted && !scheduled)
        problems.push(`- ${where} is in notRunInCi, but the plan does not schedule it there.`);
      else if (excepted && paths.length > 0)
        problems.push(`- ${where} is in notRunInCi, but ${paths.join(" and ")} runs it.`);
    }
  }
  return problems;
};

const Results = Schema.fromJsonString(
  Schema.Struct({
    testResults: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        assertionResults: Schema.Array(
          Schema.Struct({
            title: Schema.String,
            status: Schema.String,
            failureMessages: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
  }),
);
const pair = (target: typeof Target.Type, file: string, title: string) =>
  `${target}\0${file}\0${title}`;

const executed = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ran = new Set<string>();
    const signatures = { "runtime-502": 0, lost: 0, "origin-unreachable": 0 };
    const reports = (yield* fs.exists(directory))
      ? (yield* fs.readDirectory(directory, { recursive: true })).filter(
          (file) => path.basename(file) === "results.json",
        )
      : [];
    for (const report of reports) {
      const name = path.basename(path.join(directory, report, "..", "..", ".."));
      const target = yield* Schema.decodeUnknownEffect(Target)(name).pipe(
        Effect.mapError(
          () =>
            new SelectionFailed({
              message: `${report} is not in a run directory named for its target, such as cloud/report/diagnostics/results.json.`,
            }),
        ),
      );
      const results = yield* fs
        .readFileString(path.join(directory, report))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Results)));
      for (const file of results.testResults)
        for (const test of file.assertionResults)
          if (test.status === "passed" || test.status === "failed") {
            ran.add(pair(target, path.basename(file.name), test.title));
            const messages = (test.failureMessages ?? []).join("\n");
            for (const signature of ["runtime-502", "lost", "origin-unreachable"] as const)
              if (messages.includes(platformSignatures[signature])) signatures[signature] += 1;
          }
    }
    const connections: Array<DatabaseConnections> = [];
    let unreadableConnections = 0;
    const readings = (yield* fs.exists(directory))
      ? (yield* fs.readDirectory(directory, { recursive: true })).filter(
          (file) => path.basename(file) === databaseConnectionsFile,
        )
      : [];
    for (const reading of readings) {
      const decoded = yield* fs
        .readFileString(path.join(directory, reading))
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DatabaseConnections))),
          Effect.option,
        );
      if (Option.isSome(decoded)) connections.push(decoded.value);
      else unreadableConnections += 1;
    }
    return { ran, signatures, connections, unreadableConnections };
  });

const connectionsLine = (connections: ReadonlyArray<DatabaseConnections>) => {
  const count = (level: DatabaseConnections["level"]) =>
    connections.filter((reading) => reading.level === level).length;
  const worst = connections
    .filter((reading) => reading.worstMinuteMs !== undefined)
    .toSorted((a, b) => b.worstMinuteMs! - a.worstMinuteMs!)[0];
  const { severe, elevated } = connectionLatencyLevels;
  const sources = [...new Set(connections.map((reading) => reading.source))]
    .toSorted()
    .join(" and ");
  return `Database connection latency of deployed stages: ${count("severe")} severe (averaging ${severe.averageMs} ms or a minute at ${severe.worstMinuteMs} ms), ${count("elevated")} elevated (${elevated.averageMs} ms or ${elevated.worstMinuteMs} ms), ${count("normal")} normal, ${count("unknown")} unread${worst === undefined ? "" : `; the highest averaged ${worst.averageMs} ms with a worst minute of ${worst.worstMinuteMs} ms`}${connections.length === 0 ? "; no stage recorded a reading" : `, read from ${sources}`}.`;
};

const verify = (suite: string | undefined, directory: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if ((suite !== "ci" && suite !== "deployed") || directory === undefined)
      return yield* new SelectionFailed({
        message: "Usage: node e2e/ci-selection.ts verify <ci|deployed> <directory of saved runs>",
      });
    const { ran, signatures, connections, unreadableConnections } = yield* executed(directory);
    const paths =
      suite === "ci"
        ? jobRuns.map(({ name, target, titles }) => ({ name: `the ${name} job`, target, titles }))
        : [{ name: "Cloud tests on main", target: "cloud" as const, titles: deployedRuns }];
    const problems: Array<string> = [];
    let expected = 0;
    for (const { name, target, titles } of paths) {
      expected += titles.size;
      const missing = [...titles].filter(
        (title) => !ran.has(pair(target, fileOf.get(title)!, title)),
      );
      if (missing.length > 0)
        problems.push(
          `- ${name} on ${target}: ${missing.length} of ${titles.size} scenarios did not run: ${missing
            .slice(0, 10)
            .map((title) => `${fileOf.get(title)}: "${title}"`)
            .join("; ")}${missing.length > 10 ? `; and ${missing.length - 10} more` : ""}.`,
        );
    }
    if (problems.length > 0)
      return yield* new SelectionFailed({
        message: [
          `A full run must execute every scheduled scenario that e2e/ci-selection.ts counts as run in CI, passed or failed. These saved no result in ${directory}:`,
          ...problems,
          "A job or step that was skipped, cancelled or never started saves no result. Check this run's jobs. If a scenario cannot run in CI, list it in notRunInCi in e2e/ci-selection.ts with the reason.",
        ].join("\n"),
      });
    const platform =
      suite === "deployed"
        ? `\nScenario runs that failed on a platform signature: ${signatures["runtime-502"]} on Cloudflare's runtime answering 502 itself (our Worker did not answer), ${signatures.lost} on a request lost before any response, ${signatures["origin-unreachable"]} on an app origin no HTTPS connection reached within preparation's wait.\n${connectionsLine(connections)}${unreadableConnections === 0 ? "" : ` ${unreadableConnections} database connection ${unreadableConnections === 1 ? "record" : "records"} could not be read.`}\n`
        : "";
    const emulators = `\n${yield* countEmulatorRetries([directory]).pipe(
      Effect.map(emulatorRetryLine),
      Effect.orElseSucceed(
        () => "The hosted emulator calls that needed a retry could not be counted.",
      ),
    )}\n`;
    const report = `## E2E coverage\n\nEvery one of the ${expected} scenario runs ${suite === "ci" ? "the jobs here schedule" : "Cloud tests on main schedules"} executed. ${Object.keys(notRunInCi).length} scenarios are in notRunInCi.\n${platform}${emulators}`;
    yield* Console.log(report);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
  });

const patchGuards: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@alchemy.run/cloudflare-runtime": [
    "mcp-protocol-versions.spec.ts",
    "local-workflow-engine-steps.spec.ts",
    "local-workflow-engine-memory.spec.ts",
    "workflow-durability.spec.ts",
    "workflow-engine-calls.spec.ts",
  ],
  "better-auth": [
    "invitation-reaccept.spec.ts",
    "invitation-dialog.spec.ts",
    "self-host-sso.spec.ts",
    "cloud-auth-rate-limit.spec.ts",
  ],
  "@better-auth/oauth-provider": [
    "mcp-oauth-refresh.spec.ts",
    "local-mcp-connections.spec.ts",
    "bearer-auth-refusals.spec.ts",
  ],
  "@opencode-ai/codemode": [
    "mcp-catalog.spec.ts",
    "mcp-execute-concurrency.spec.ts",
    "mcp-execute-lazy.spec.ts",
    "local-mcp-connections.spec.ts",
  ],
  effect: [
    "mcp-telemetry-privacy.spec.ts",
    "mcp-protocol-versions.spec.ts",
    "cloud-mcp-session-timing.spec.ts",
  ],
};

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

const pinned = (
  manifest: typeof Manifest.Type,
  dependency: string,
  blob: (path: string) => string | undefined,
) =>
  JSON.stringify([
    manifest.dependencies?.[dependency],
    manifest.overrides?.[dependency],
    Object.entries(manifest.patchedDependencies ?? {})
      .filter(([selector]) => selector.startsWith(`${dependency}@`))
      .map(([selector, path]) => [selector, blob(path)]),
  ]);

const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

const guardedPatches = (mainManifest: string, mainPatches: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const main = yield* Schema.decodeUnknownEffect(Manifest)(mainManifest);
    const head = yield* Schema.decodeUnknownEffect(Manifest)(
      yield* fs.readFileString("package.json"),
    );
    const mainBlobs = new Map(
      mainPatches
        .split("\n")
        .map((line) => line.trim().split(" "))
        .filter((parts) => parts.length === 2)
        .map(([id, name]) => [`patches/${name}`, id]),
    );
    const headBlobs = new Map<string, string>();
    for (const path of Object.values(head.patchedDependencies ?? {}))
      if (yield* fs.exists(path)) headBlobs.set(path, blobId(yield* fs.readFile(path)));
    return Object.keys(patchGuards).filter(
      (dependency) =>
        pinned(main, dependency, (path) => mainBlobs.get(path)) !==
        pinned(head, dependency, (path) => headBlobs.get(path)),
    );
  });

const guardedFiles = <E, R>(mainListing: (directory: string) => Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mainBlobs = new Map<string, string>();
    for (const directory of new Set(Object.keys(fileGuards).map((file) => path.dirname(file))))
      for (const line of (yield* mainListing(directory)).split("\n")) {
        const [id, file] = line.trim().split(" ");
        if (id !== undefined && file !== undefined) mainBlobs.set(file, id);
      }
    const guards: Array<string> = [];
    for (const [file, specs] of Object.entries(fileGuards)) {
      const head = (yield* fs.exists(file)) ? blobId(yield* fs.readFile(file)) : undefined;
      if (head !== mainBlobs.get(file)) guards.push(...specs);
    }
    return guards;
  });

const example = "```e2e\ngroups.spec.ts\ninvitation-roles.spec.ts\n```";

interface Suite {
  readonly config: string;
  readonly commands: ReadonlyArray<string>;
  readonly workflows: ReadonlyArray<string>;
  readonly everyPullRequest: boolean;
}

const everyRunJobs = [
  "static",
  "site",
  "apps-package",
  "tooling",
  "tooling-release",
  "tooling-cloud",
];

const PackageScripts = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
const suiteConfigs: Record<string, () => Promise<unknown>> = {
  "alchemy-dev-output.config.ts": () => import("./alchemy-dev-output.config.ts"),
  "alchemy-first-builds.config.ts": () => import("./alchemy-first-builds.config.ts"),
  "chatgpt-sign-in.config.ts": () => import("./chatgpt-sign-in.config.ts"),
  "cloud-proxy-keep-alive.config.ts": () => import("./cloud-proxy-keep-alive.config.ts"),
  "apps-bumped.config.ts": () => import("./apps-bumped.config.ts"),
  "apps-job.config.ts": () => import("./apps-job.config.ts"),
  "apps-published.config.ts": () => import("./apps-published.config.ts"),
  "beta-due.config.ts": () => import("./beta-due.config.ts"),
  "billing.config.ts": () => import("./billing.config.ts"),
  "ci-selection.config.ts": () => import("./ci-selection.config.ts"),
  "ci-supersede.config.ts": () => import("./ci-supersede.config.ts"),
  "ci-repeat.config.ts": () => import("./ci-repeat.config.ts"),
  "collector-job.config.ts": () => import("./collector-job.config.ts"),
  "conflict-markers.config.ts": () => import("./conflict-markers.config.ts"),
  "coverage-unreadable.config.ts": () => import("./coverage-unreadable.config.ts"),
  "macos-staple.config.ts": () => import("./macos-staple.config.ts"),
  "npm-channel.config.ts": () => import("./npm-channel.config.ts"),
  "publish-guard.config.ts": () => import("./publish-guard.config.ts"),
  "workflow-caches.config.ts": () => import("./workflow-caches.config.ts"),
  "telemetry-event-lifetime.config.ts": () => import("./telemetry-event-lifetime.config.ts"),
  "outbound-routes.config.ts": () => import("./outbound-routes.config.ts"),
  "cli-startup-imports.config.ts": () => import("./cli-startup-imports.config.ts"),
  "process-output-exit.config.ts": () => import("./process-output-exit.config.ts"),
  "cloud-deploy-origin.config.ts": () => import("./cloud-deploy-origin.config.ts"),
  "deploy-decision.config.ts": () => import("./deploy-decision.config.ts"),
  "dashboard-file-names.config.ts": () => import("./dashboard-file-names.config.ts"),
  "database-connections.config.ts": () => import("./database-connections.config.ts"),
  "effect-mcp.config.ts": () => import("./effect-mcp.config.ts"),
  "desktop-next-server.config.ts": () => import("./desktop-next-server.config.ts"),
  "desktop-recovery.config.ts": () => import("./desktop-recovery.config.ts"),
  "desktop-release.config.ts": () => import("./desktop-release.config.ts"),
  "desktop-update.config.ts": () => import("./desktop-update.config.ts"),
  "emulator-failures.config.ts": () => import("./emulator-failures.config.ts"),
  "emulators-server.config.ts": () => import("./emulators-server.config.ts"),
  "fixture-start.config.ts": () => import("./fixture-start.config.ts"),
  "scenario-parts.config.ts": () => import("./scenario-parts.config.ts"),
  "export-public.config.ts": () => import("./export-public.config.ts"),
  "docker-release.config.ts": () => import("./docker-release.config.ts"),
  "installer.config.ts": () => import("./installer.config.ts"),
  "local-bootstrap.config.ts": () => import("./local-bootstrap.config.ts"),
  "local-disk.config.ts": () => import("./local-disk.config.ts"),
  "lost-connections-lifecycle.config.ts": () => import("./lost-connections-lifecycle.config.ts"),
  "lost-connections.config.ts": () => import("./lost-connections.config.ts"),
  "lockfile-sync.config.ts": () => import("./lockfile-sync.config.ts"),
  "npm-launcher.config.ts": () => import("./npm-launcher.config.ts"),
  "pglite.config.ts": () => import("./pglite.config.ts"),
  "pr-preview-selection.config.ts": () => import("./pr-preview-selection.config.ts"),
  "playwright-routes.config.ts": () => import("./playwright-routes.config.ts"),
  "posthog-experiment-lifecycle.config.ts": () =>
    import("./posthog-experiment-lifecycle.config.ts"),
  "prepare-cache.config.ts": () => import("./prepare-cache.config.ts"),
  "part-results.config.ts": () => import("./part-results.config.ts"),
  "process-identity.config.ts": () => import("./process-identity.config.ts"),
  "cloud-postgres-volumes.config.ts": () => import("./cloud-postgres-volumes.config.ts"),
  "release-archives.config.ts": () => import("./release-archives.config.ts"),
  "release-evidence.config.ts": () => import("./release-evidence.config.ts"),
  "release-notes.config.ts": () => import("./release-notes.config.ts"),
  "release-notes-render.config.ts": () => import("./release-notes-render.config.ts"),
  "removal-evidence.config.ts": () => import("./removal-evidence.config.ts"),
  "request-failures.config.ts": () => import("./request-failures.config.ts"),
  "run-retention.config.ts": () => import("./run-retention.config.ts"),
  "snapshot-updates.config.ts": () => import("./snapshot-updates.config.ts"),
  "standalone-lockdown.config.ts": () => import("./standalone-lockdown.config.ts"),
  "subrequest-depth.config.ts": () => import("./subrequest-depth.config.ts"),
  "test-stage-branch.config.ts": () => import("./test-stage-branch.config.ts"),
  "test-stage-domain-cleanup.config.ts": () => import("./test-stage-domain-cleanup.config.ts"),
  "test-stage-orphans.config.ts": () => import("./test-stage-orphans.config.ts"),
  "test-stage-unreadable.config.ts": () => import("./test-stage-unreadable.config.ts"),
  "typecheck-runner.config.ts": () => import("./typecheck-runner.config.ts"),
  "webhook-sweep-waits.config.ts": () => import("./webhook-sweep-waits.config.ts"),
  "welcome-email.config.ts": () => import("./welcome-email.config.ts"),
  "worker-sizes.config.ts": () => import("./worker-sizes.config.ts"),
};
const SuiteConfig = Schema.Struct({
  default: Schema.Struct({ test: Schema.Struct({ include: Schema.Array(Schema.String) }) }),
});

const separateSuites = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const e2e = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const root = path.dirname(e2e);
  const { scripts } = yield* fs
    .readFileString(path.join(root, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PackageScripts))));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflows = yield* Effect.forEach(
    (yield* fs.readDirectory(workflowDirectory)).filter((name) => name.endsWith(".yml")).sort(),
    (name) =>
      fs.readFileString(path.join(workflowDirectory, name)).pipe(
        Effect.map((text) => ({
          label: `${/^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name} (.github/workflows/${name})`,
          text,
        })),
      ),
  );
  const suites = new Map<string, Suite>();
  const checksText =
    workflows.find(({ label }) => label.endsWith("(.github/workflows/checks.yml)"))?.text ?? "";
  const checksJob = (job: string) => {
    const start = checksText.indexOf(`\n  ${job}:\n`);
    if (start === -1) return "";
    const rest = checksText.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };
  const configs = (yield* fs.readDirectory(e2e))
    .filter((name) => name.endsWith(".config.ts") && name !== "vitest.config.ts")
    .sort();
  const unlisted = configs.filter((name) => !(name in suiteConfigs));
  const missing = Object.keys(suiteConfigs).filter((name) => !configs.includes(name));
  if (unlisted.length > 0 || missing.length > 0)
    return yield* new SelectionFailed({
      message: `suiteConfigs in e2e/ci-selection.ts must list every e2e/*.config.ts except vitest.config.ts, so the selection can tell which suite runs each spec file. ${[
        ...unlisted.map((name) => `Add e2e/${name}.`),
        ...missing.map((name) => `Remove ${name}, which no longer exists.`),
      ].join(" ")}`,
    });
  for (const name of configs) {
    const config = `e2e/${name}`;
    const unsupported = `${config} must export a config object whose test.include lists e2e/tests/*.spec.ts paths, so the selection can tell which suite runs them.`;
    const module = yield* Effect.tryPromise({
      try: suiteConfigs[name]!,
      catch: (cause) =>
        new SelectionFailed({ message: `${config} failed to load: ${String(cause)}` }),
    });
    const { include } = (yield* Schema.decodeUnknownEffect(SuiteConfig)(module).pipe(
      Effect.mapError(() => new SelectionFailed({ message: unsupported })),
    )).default.test;
    const files = include.flatMap(
      (file) => /^e2e\/tests\/([\w.-]+\.spec\.ts)$/.exec(file)?.[1] ?? [],
    );
    if (files.length === 0 || files.length !== include.length)
      return yield* new SelectionFailed({ message: unsupported });
    const passesConfig = new RegExp(`--config[= ]${escape(config)}(?![\\w.-])`);
    const commands = Object.entries(scripts)
      .filter(([, command]) => passesConfig.test(command))
      .map(([script]) => `bun run ${script}`);
    const runs = (text: string) =>
      passesConfig.test(text) ||
      commands.some((command) => new RegExp(`${escape(command)}(?![\\w:-])`).test(text));
    for (const file of files)
      suites.set(file, {
        config,
        commands,
        workflows: workflows.filter(({ text }) => runs(text)).map(({ label }) => label),
        everyPullRequest: everyRunJobs.some((job) => runs(checksJob(job))),
      });
  }
  return suites;
});

const runsElsewhere = (file: string, suite: Suite | undefined, where?: string) => {
  const at = where ?? file;
  const nothing =
    where === undefined
      ? "so these jobs do not run it."
      : `so naming it here runs nothing. Remove ${file} from the e2e block.`;
  if (suite === undefined) {
    const deployed = [...deployedRuns].filter((title) => fileOf.get(title) === file);
    return deployed.length > 0
      ? `- ${at}: only the deployed stage runs ${file}'s scenarios, in Cloud tests on main after merge, ${nothing} To run its scenarios before merging, run them on a deployed stage: ${verifyCommand(deployed)}`
      : `- ${at}: these jobs exclude all of ${file}'s scenarios (see the job patterns in e2e/ci-selection.ts), ${nothing}`;
  }
  const command = suite.commands[0] ?? `bunx vitest run --config ${suite.config}`;
  if (suite.workflows.length === 0)
    return `- ${at}: ${file} runs only by hand, with ${suite.config} (${command}); no workflow runs it, ${nothing}`;
  return suite.everyPullRequest
    ? `- ${at}: ${file} runs with ${suite.config} in Checks on every pull request anyway, ${where === undefined ? "so these jobs do not run it." : `so the e2e block cannot select it. Remove ${file} from the e2e block.`} Locally: ${command}.`
    : `- ${at}: ${file} runs with ${suite.config} in ${suite.workflows.join(" and ")}, not in these jobs, ${nothing} Locally: ${command}.`;
};

const blockLine = (block: string, token: string) => {
  const lines = block.split("\n");
  const index = lines.findIndex((line) => line.split(/[\s,]+/).includes(token));
  return index === -1
    ? `\`${token}\` in the e2e block`
    : `line ${index + 1} of the e2e block, \`${lines[index]!.trim()}\``;
};

const verifyCommand = (titles: ReadonlyArray<string>) =>
  `bun run e2e:deployed --database planetscale --test-name '^(?:${titles.map(escape).join("|")})$'`;

const editDistance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
};

const nearest = (name: string, names: Iterable<string>) =>
  [...names]
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .toSorted((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);

const keyed = (lines: string, description: string | undefined) =>
  [
    lines,
    `selection=${selectionKey(lines)}`,
    ...(description === undefined ? [] : [`worker-growth=${workerGrowthKey(description)}`]),
    "",
  ].join("\n");

const spoken = (duration: Duration.Duration) => {
  const seconds = Duration.toSeconds(duration);
  return seconds % 60 === 0 && seconds > 0
    ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `${seconds} second${seconds === 1 ? "" : "s"}`;
};

export const skipDirective = (
  text: string,
): { readonly directive: string; readonly change: string } | undefined => {
  const bracketed = text.match(/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/iu);
  if (bracketed !== null)
    return {
      directive: bracketed[0],
      change: `GitHub honours ${bracketed[0]} anywhere in a message, in a sentence or inside backticks too, so remove it or write it without its brackets`,
    };
  const last = text.trim().split(/\r?\n/u).at(-1)!.trim();
  if (/^skip-checks: ?true$/iu.test(last))
    return {
      directive: last,
      change: `GitHub honours ${last} as the last line of a message, the end of its trailers, so remove that line`,
    };
  return undefined;
};

export const skipDirectiveIn = (
  texts: ReadonlyArray<{ readonly what: string; readonly text: string }>,
) =>
  texts.flatMap(({ what, text }) => {
    const found = skipDirective(text);
    return found === undefined ? [] : [{ what, ...found }];
  })[0];

export const listedCommits = 250;

const gh = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("gh", args));
    const [output, error, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* new SelectionFailed({
        message: `gh ${args.join(" ")} failed: ${error.trim()}`,
      });
    return output;
  }).pipe(Effect.scoped);

const ghRead = (args: ReadonlyArray<string>) =>
  gh(args).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("500 millis"),
      while: (error) =>
        error._tag === "SelectionFailed" &&
        !/\bHTTP \d{3}\b/u.test(error.message) &&
        /dial tcp|connection reset|connection refused|i\/o timeout|TLS handshake timeout|unexpected EOF|no such host|network is unreachable|context deadline exceeded/iu.test(
          error.message,
        ),
    }),
  );

const readPullRequest = (input: {
  readonly repository: string;
  readonly number: string;
  readonly headRef: string;
  readonly wait: Duration.Duration;
  readonly poll: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const waitedFor: Array<string> = [];
    for (;;) {
      const body = yield* gh([
        "api",
        `repos/${input.repository}/pulls/${input.number}`,
        "--jq",
        '.body // ""',
      ]);
      const parsed = parseRequested(body);
      const skip = parsed._tag === "Skip";
      const above = skip
        ? (yield* gh([
            "pr",
            "list",
            "--repo",
            input.repository,
            "--base",
            input.headRef,
            "--state",
            "open",
            "--json",
            "number",
            "--jq",
            ".[].number",
          ]))
            .split(/\s+/)
            .filter((number) => number.length > 0)
        : [];
      const missing =
        parsed._tag === "Missing"
          ? "an e2e block in the description"
          : skip && above.length === 0
            ? "an open pull request based on this branch"
            : undefined;
      const elapsed = Duration.millis((yield* Clock.currentTimeMillis) - start);
      if (missing === undefined || Duration.isGreaterThanOrEqualTo(elapsed, input.wait)) {
        if (waitedFor.length > 0)
          yield* Console.log(
            `Waited ${Math.round(Duration.toSeconds(elapsed))} s for ${waitedFor.join(", then ")}${missing === undefined ? "." : `; there is still no ${missing.replace(/^an? /, "")}.`}`,
          );
        return { parsed, above, body };
      }
      if (waitedFor.at(-1) !== missing) {
        waitedFor.push(missing);
        yield* Console.log(`Waiting up to ${spoken(input.wait)} for ${missing}.`);
      }
      yield* Effect.sleep(input.poll);
    }
  });

const requested = (parsed: Requested, retry: string) =>
  Effect.gen(function* () {
    switch (parsed._tag) {
      case "Missing":
        return yield* new SelectionFailed({
          message: `The pull request description has no e2e block. Name the spec files that exercise the change, for example:\n${example}\nWrite none when no scenario can observe it, or all with a reason for a cross-cutting change. ${retry} See AGENTS.md, "Choosing a PR's E2E scenarios".`,
        });
      case "Several":
        return yield* new SelectionFailed({
          message: "The pull request description has more than one e2e block. Keep one.",
        });
      case "AllWithoutReason":
        return yield* new SelectionFailed({
          message: `The e2e block says all without a reason. The full suite takes about three times as long as a selection. Name the spec files that exercise the change, for example:\n${example}\nor keep all and say why every scenario is needed, for example "all: changes the lockfile".`,
        });
      case "All":
        return { all: parsed.reason };
      case "Skip":
        return "skip" as const;
      case "Named":
        return parsed.tokens;
    }
  });

const checkNamed = (
  tokens: ReadonlyArray<string>,
  block: string,
  suites: ReadonlyMap<string, Suite>,
  changedDeployedOnly: ReadonlySet<string>,
  retry: string,
) =>
  Effect.gen(function* () {
    const named = tokens.map((token) => token.replace(/^e2e\/tests\//, ""));
    const unknown = tokens.filter(
      (_, index) => !specFiles.has(named[index]!) && !suites.has(named[index]!),
    );
    if (unknown.length > 0)
      return yield* new SelectionFailed({
        message: [
          "The e2e block names files that are not spec files in e2e/tests/:",
          ...unknown.map(
            (token) =>
              `- ${blockLine(block, token)}: no spec file has this name. The nearest names are ${nearest(token.replace(/^e2e\/tests\//, ""), [...specFiles, ...suites.keys()]).join(", ")}. Write the name exactly as it appears in e2e/tests/; a new spec file needs its scenarios in e2e/test-plan.ts first.`,
          ),
          `Correct each of these lines in the description's e2e block. ${retry}`,
        ].join("\n"),
      });
    const elsewhere = named.filter((file) => !jobFiles.has(file) && !changedDeployedOnly.has(file));
    if (elsewhere.length > 0)
      return yield* new SelectionFailed({
        message: [
          "The e2e block names spec files that CI's E2E jobs do not run, so naming them here tests nothing:",
          ...elsewhere.map((file) =>
            runsElsewhere(file, suites.get(file), blockLine(block, tokens[named.indexOf(file)]!)),
          ),
          `Name the spec files these jobs run that exercise the change, or write none. ${retry}`,
        ].join("\n"),
      });
    return named;
  });

runMain(
  Effect.gen(function* () {
    const [command, ...args] = process.argv.slice(2);
    if (command === "verify") return yield* verify(args[0], args[1]);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pullRequest = yield* Config.String("E2E_PULL_REQUEST").pipe(Config.withDefault(""));
    const headRef = yield* Config.String("E2E_HEAD_REF").pipe(Config.withDefault(""));
    const repository = yield* Config.String("GITHUB_REPOSITORY").pipe(Config.withDefault(""));
    const defaultBranch = yield* Config.String("E2E_DEFAULT_BRANCH").pipe(Config.withDefault(""));
    const runId = yield* Config.String("GITHUB_RUN_ID").pipe(Config.withDefault("<run-id>"));
    const wait = Duration.seconds(
      yield* Config.Number("E2E_DESCRIPTION_WAIT_SECONDS").pipe(Config.withDefault(180)),
    );
    const poll = Duration.seconds(
      yield* Config.Number("E2E_DESCRIPTION_POLL_SECONDS").pipe(Config.withDefault(15)),
    );
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);

    const local = (yield* Config.String("E2E_LOCAL_CHECK").pipe(Config.withDefault(""))) !== "";
    if (local && (yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""))) === "true")
      return yield* new SelectionFailed({
        message:
          "E2E_LOCAL_CHECK is set in a GitHub Actions run. It is the mode of e2e/check-description.ts, which passes a skip that has no layer above; a workflow must never set it. Remove it from the workflow, runner or repository variables that set it.",
      });
    const retry = local
      ? "Edit the description and check it again"
      : `CI waited ${spoken(wait)} for the description. Once it is fixed, rerun the whole workflow: gh run rerun ${runId}`;
    const read =
      pullRequest === ""
        ? undefined
        : yield* readPullRequest({ repository, number: pullRequest, headRef, wait, poll });
    const block = read === undefined ? undefined : yield* requested(read.parsed, `${retry}.`);
    const above = read === undefined ? [] : read.above;
    const draft =
      read === undefined
        ? undefined
        : local
          ? (yield* Config.String("E2E_READY").pipe(Config.withDefault(""))) !== "true"
          : yield* gh(["api", `repos/${repository}/pulls/${pullRequest}`, "--jq", ".draft"]).pipe(
              Effect.map((text) => text.trim() === "true"),
              Effect.tap((isDraft) =>
                Console.log(
                  `Pull request ${pullRequest} is ${isDraft ? "a draft" : "ready for review"}.`,
                ),
              ),
              Effect.catch(() =>
                Console.log(
                  `Could not read whether pull request ${pullRequest} is a draft, so it runs as ready for review.`,
                ).pipe(Effect.as(false)),
              ),
            );
    const draftLine = `draft=${draft === true}`;
    if (read !== undefined && !local) {
      const unread = (what: string, cause: string) =>
        new SelectionFailed({
          message: `Could not read ${what} of pull request ${pullRequest} (${cause.split("\n")[0]}), so whether the squash that lands it would skip main's CI is not known, and select fails rather than pass unchecked. Run this workflow again: gh run rerun ${runId}`,
        });
      const pull = yield* ghRead([
        "api",
        `repos/${repository}/pulls/${pullRequest}`,
        "--jq",
        "{title, commits} | @json",
      ]).pipe(
        Effect.mapError((error) => unread("the title and commit count", error.message)),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(text) as { title?: unknown; commits?: unknown };
              if (
                typeof parsed.title !== "string" ||
                typeof parsed.commits !== "number" ||
                !Number.isInteger(parsed.commits) ||
                parsed.commits < 1
              )
                throw new Error(`unexpected answer ${text.trim().slice(0, 200)}`);
              return { title: parsed.title, commits: parsed.commits };
            },
            catch: (cause) => unread("the title and commit count", String(cause)),
          }),
        ),
      );
      if (pull.commits > listedCommits)
        return yield* new SelectionFailed({
          message: `Pull request ${pullRequest} has ${pull.commits} commits. GitHub lists at most ${listedCommits} of a pull request's commits, so the messages of the rest, which the squash that lands it carries onto main, cannot be checked for a directive that would skip main's CI. Squash its commits into ${listedCommits} or fewer (git rebase, then a force push), or split it into a stack of smaller pull requests; the push starts a new run.`,
        });
      const commits = yield* ghRead([
        "api",
        "--paginate",
        `repos/${repository}/pulls/${pullRequest}/commits?per_page=100`,
        "--jq",
        '.[] | {what: ("commit " + .sha[0:9]), text: .commit.message} | @json',
      ]).pipe(
        Effect.mapError((error) => unread("the commit messages", error.message)),
        Effect.flatMap((text) =>
          Effect.try({
            try: () =>
              text
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => {
                  const parsed = JSON.parse(line) as { what?: unknown; text?: unknown };
                  if (typeof parsed.what !== "string" || typeof parsed.text !== "string")
                    throw new Error(`unexpected answer ${line.slice(0, 200)}`);
                  return { what: parsed.what, text: parsed.text };
                }),
            catch: (cause) => unread("the commit messages", String(cause)),
          }),
        ),
      );
      if (commits.length !== pull.commits)
        return yield* unread(
          "every commit message",
          `read ${commits.length} of its ${pull.commits} commits; a push between the two reads also does this`,
        );
      const found = skipDirectiveIn([{ what: "the title", text: pull.title.trim() }, ...commits]);
      if (found !== undefined)
        return yield* new SelectionFailed({
          message: `${found.what[0]!.toUpperCase()}${found.what.slice(1)} of pull request ${pullRequest} holds ${JSON.stringify(found.directive)}. GitHub starts no push workflow for a commit whose message holds that, and the squash that lands this pull request carries its title and every commit message, so main would get no CI, Deploy or public export for it. ${found.change}: the title with gh pr edit ${pullRequest} --title, a commit with git rebase and a force push. Then run this workflow again: gh run rerun ${runId}`,
        });
    }
    if (block === "skip") {
      if (above.length === 0 && local && pullRequest === "0") {
        yield* Console.log(
          `The e2e block says skip (${blockLine(blocksIn(read!.body)[0]!, "skip")}): this layer runs nothing, and the layer above, an open pull request whose base is ${headRef}, checks the combined change. A skip cannot be checked before both pull requests exist. Check the layer above's description now; once both are open, check this one with --pr.`,
        );
        return;
      }
      if (above.length === 0)
        return yield* new SelectionFailed({
          message: local
            ? `The e2e block says skip (${blockLine(blocksIn(read!.body)[0]!, "skip")}), which only a lower layer of a stack may say: pull request ${pullRequest} is open, and no open pull request has this branch, ${headRef}, as its base, so CI's select job would fail it. Open the layer above with base ${headRef}, then check again. If this pull request is not a lower layer of a stack, replace skip with the spec files that exercise the change.`
            : `The e2e block says skip (${blockLine(blocksIn(read!.body)[0]!, "skip")}), which only a lower layer of a stack may say: this run waited ${spoken(wait)} for the layer above, an open pull request whose base is this branch, ${headRef}, and there is none. Open the layer above with base ${headRef}, then run this workflow again: gh run rerun ${runId}. If this pull request is not a lower layer of a stack, replace skip with the spec files that exercise the change.`,
        });
      const report = [
        "## E2E selection",
        "",
        `Skipped: a lower stack layer under ${above.map((number) => `#${number}`).join(", ")}. The layer above checks the combined change.`,
        "",
      ].join("\n");
      yield* Console.log(report);
      if (Option.isSome(output))
        yield* fs.writeFileString(
          output.value,
          keyed(`skip=true\n${draftLine}\ngate=${draft === true ? "draft" : "stack"}`, read?.body),
          { flag: "a" },
        );
      if (Option.isSome(summary))
        yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
      return;
    }
    const uncovered = coverageProblems();
    if (uncovered.length > 0)
      return yield* new SelectionFailed({
        message: [
          "Every scenario e2e/test-plan.ts schedules must run in CI, or it goes stale without anyone noticing:",
          ...uncovered,
          'Add a scenario to a job pattern in e2e/ci-selection.ts; a Cloud scenario without runtime "managed", "rate-limited" or "rolled-back" runs in Cloud tests on main. Otherwise mark the target not-run with its reason in e2e/test-plan.ts, or add it to notRunInCi in e2e/ci-selection.ts with why no CI job runs it.',
        ].join("\n"),
      });
    const compareBase = yield* Config.String("E2E_COMPARE_BASE").pipe(Config.withDefault(""));
    const compareHead = yield* Config.String("E2E_COMPARE_HEAD").pipe(Config.withDefault(""));
    const compared =
      compareBase === "" || compareHead === "" || repository === ""
        ? undefined
        : (yield* gh([
            "api",
            `repos/${repository}/compare/${compareBase}...${compareHead}`,
            "--jq",
            ".files[] | .filename, (.previous_filename // empty)",
          ]))
            .split("\n")
            .filter((file) => file !== "");
    if (
      read === undefined &&
      (yield* Config.String("GITHUB_EVENT_NAME").pipe(Config.withDefault(""))) === "push" &&
      compareHead !== "" &&
      repository !== ""
    ) {
      const landed = yield* gh([
        "api",
        `repos/${repository}/commits/${compareHead}/pulls`,
        "--jq",
        '[.[] | select(.merged_at != null) | {number, body: (.body // "")}]',
      ]).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as ReadonlyArray<{ number: number; body: string }>,
            catch: (cause) => new SelectionFailed({ message: String(cause) }),
          }),
        ),
        Effect.catch((error) =>
          Console.log(
            `Could not read which pull request ${compareHead.slice(0, 9)} landed (${error.message.split("\n")[0]}), so whether it was a lower stack layer landed alone is not checked.`,
          ).pipe(Effect.as([])),
        ),
      );
      for (const pull of landed.filter(({ body }) => parseRequested(body)._tag === "Skip")) {
        const message = `This push to main ends on #${pull.number}, a lower stack layer (its e2e block says skip), so it landed without the layers above it, whose run tested it. Land a stack with gh stack merge <top pull request> --yes --squash, which lands every layer in one push, never layer by layer (AGENTS.md).`;
        yield* Console.log(`::warning title=Stack layer landed alone::${message}`);
        if (Option.isSome(summary))
          yield* fs.writeFileString(summary.value, `${message}\n\n`, { flag: "a" });
      }
    }
    const changed =
      read === undefined
        ? ""
        : yield* gh([
            "api",
            "--paginate",
            `repos/${repository}/pulls/${pullRequest}/files`,
            "--jq",
            ".[].filename",
          ]);
    const suites = yield* separateSuites;
    const changedSpecs = changed
      .split("\n")
      .map((file) => /^e2e\/tests\/([\w.-]+\.spec\.ts)$/.exec(file.trim())?.[1])
      .filter((file) => file !== undefined);
    const tests = yield* path.fromFileUrl(new URL("tests/", import.meta.url));
    const stackSpecs =
      read === undefined
        ? []
        : compared === undefined || compared.length >= compareFileLimit
          ? (yield* fs.readDirectory(tests)).filter((file) => file.endsWith(".spec.ts"))
          : [
              ...new Set([
                ...changedSpecs,
                ...compared
                  .map((file) => /^e2e\/tests\/([\w.-]+\.spec\.ts)$/.exec(file)?.[1])
                  .filter((file) => file !== undefined),
              ]),
            ];
    const unregistered = yield* Effect.filter(
      stackSpecs.filter((file) => !specFiles.has(file) && !suites.has(file)),
      (file) => fs.exists(path.join(tests, file)),
    );
    if (unregistered.length > 0)
      return yield* new SelectionFailed({
        message: `No CI job runs these spec files, because neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${unregistered.join(", ")}. Add their scenarios to e2e/test-plan.ts.`,
      });
    const changedDeployedOnly = deployedOnly.filter((title) =>
      stackSpecs.includes(fileOf.get(title)!),
    );
    const deployedOnlyRun = new Set(changedDeployedOnly.filter((title) => managedCloud.has(title)));
    const deployedOnlyUnrun = changedDeployedOnly.filter((title) => !deployedOnlyRun.has(title));
    const planChanged =
      compared === undefined ||
      compared.length >= compareFileLimit ||
      compared.includes("e2e/test-plan.ts");
    const changedDeployed = [...deployedRuns].filter(
      (title) => planChanged || stackSpecs.includes(fileOf.get(title)!),
    );
    if (read !== undefined && defaultBranch !== "" && changedDeployed.length > 0) {
      const mainPlan = yield* gh([
        "api",
        `repos/${repository}/contents/e2e/test-plan.ts?ref=${defaultBranch}`,
        "-H",
        "Accept: application/vnd.github.raw+json",
      ]).pipe(Effect.option);
      if (Option.isNone(mainPlan) || !mainPlan.value.includes("export const scenarios"))
        yield* Console.log(
          "Could not read main's e2e/test-plan.ts, so whether this pull request adds scenarios to the deployed suite was not checked.",
        );
      else {
        const added = changedDeployed.filter((title) => !namedIn(mainPlan.value, title));
        if (added.length > 0 && !deployedVerification.test(read.body))
          return yield* new SelectionFailed({
            message: [
              "These scenarios are new to the deployed suite. Cloud tests on main runs them on a deployed stage after merge, and no job here can run them there:",
              ...added.toSorted().map((title) => `- ${fileOf.get(title)}: ${title}`),
              "Run them on a deployed stage before merging:",
              `    ${verifyCommand(added)}`,
              `When that command passes, add this line to the description, on a line of its own, then ${local ? "check it again" : "run this workflow again"}:`,
              `Verified on a deployed stage: ${verifyCommand(added)} passed`,
              `${retry}.`,
            ].join("\n"),
          });
      }
    }
    const chosen = Array.isArray(block)
      ? yield* checkNamed(
          block,
          blocksIn(read!.body)[0]!,
          suites,
          new Set([...deployedOnlyRun].map((title) => fileOf.get(title)!)),
          `${retry}.`,
        )
      : block;
    const ready = draft === false;
    const broad =
      read === undefined
        ? []
        : compared === undefined || compared.length >= compareFileLimit
          ? ["(more files than the comparison with main lists)"]
          : broadChanges(compared);
    const broadReason = `changes files outside e2e/narrowing.ts since main: ${broad.slice(0, 5).join(", ")}${broad.length > 5 ? ` and ${broad.length - 5} more` : ""}`;
    const named =
      ready && Array.isArray(chosen) && broad.length > 0
        ? { all: `ready for review, and ${broadReason}` }
        : chosen;
    const changedElsewhere = stackSpecs.filter(
      (file) =>
        (specFiles.has(file) || suites.has(file)) &&
        !jobFiles.has(file) &&
        ![...deployedOnlyRun].some((title) => fileOf.get(title) === file),
    );
    const repinned =
      read === undefined || defaultBranch === ""
        ? []
        : yield* guardedPatches(
            yield* gh([
              "api",
              `repos/${repository}/contents/package.json?ref=${defaultBranch}`,
              "-H",
              "Accept: application/vnd.github.raw+json",
            ]),
            yield* gh([
              "api",
              `repos/${repository}/contents/patches?ref=${defaultBranch}`,
              "--jq",
              '.[] | "\\(.sha) \\(.name)"',
            ]),
          );
    const guarded = [...new Set(repinned.flatMap((dependency) => patchGuards[dependency]!))];
    const guardedByFile =
      read === undefined || defaultBranch === ""
        ? []
        : yield* guardedFiles((directory) =>
            gh([
              "api",
              `repos/${repository}/contents/${directory}?ref=${defaultBranch}`,
              "--jq",
              '.[] | "\\(.sha) \\(.path)"',
            ]),
          );
    const harnessChanged =
      compared === undefined ||
      compared.length >= compareFileLimit ||
      compared.some((file) =>
        harnessScenarios.paths.some((prefix) =>
          prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
        ),
      );
    let savePathSize: number | undefined;
    const saveChanged =
      compared === undefined ||
      compared.length >= compareFileLimit ||
      (compared.length > 0 &&
        (yield* savePathFiles.pipe(
          Effect.tap((files) => Effect.sync(() => (savePathSize = files.size))),
          Effect.map((files) => compared.some((file) => files.has(file))),
          Effect.mapError((error) => new SelectionFailed({ message: error.message })),
        )));
    const searchChanged =
      compared === undefined || compared.length >= compareFileLimit || mcpSearchChanged(compared);
    const lanes =
      read === undefined
        ? undefined
        : compared === undefined || compared.length >= compareFileLimit
          ? { "release-docker": ["(every file)"], "release-local": ["(every file)"] }
          : (({ "release-docker": docker, "release-local": local }) => ({
              "release-docker": docker,
              "release-local": local,
            }))(lanesFor(yield* releaseSources, compared));
    const collector =
      compared === undefined || compared.length >= compareFileLimit || collectorChanged(compared);
    const engine =
      read === undefined
        ? undefined
        : compared === undefined || compared.length >= compareFileLimit
          ? ["(every file)"]
          : [
              ...lanesFor(yield* releaseSources, compared)["release-docker-engine"],
              ...(repinned.includes(packagedEngineDependency)
                ? [`${packagedEngineDependency}'s pin or patch`]
                : []),
            ];
    const files =
      named === undefined || "all" in named
        ? undefined
        : new Set([
            ...named,
            ...guarded,
            ...guardedByFile,
            ...(collector ? collectorScenarios : []),
            ...stackSpecs.filter((file) => jobFiles.has(file)),
            ...[...deployedOnlyRun].map((title) => fileOf.get(title)!),
          ]);

    const jobTitles = (job: string, definition: (typeof jobs)[keyof typeof jobs]) => {
      const { target, pattern } = definition;
      const base = new RegExp(pattern);
      const extra = new Set<string>([
        ...(job === deployedOnlyJob ? deployedOnlyRun : []),
        ...(job === harnessScenarios.job
          ? harnessTitles.filter(
              (title) => harnessChanged || files?.has(fileOf.get(title)!) === true,
            )
          : []),
        ...(job === saveScenarios.job && saveChanged && files !== undefined ? saveTitles : []),
      ]);
      return planFor(definition)
        .filter(
          (scenario) =>
            scenario.targets[target].status === "scheduled" &&
            ((base.test(scenario.title) &&
              (files === undefined ||
                files.has(scenario.file) ||
                (target === "cloud" && searchChanged && mcpSearchTitles.has(scenario.title)))) ||
              extra.has(scenario.title)),
        )
        .map((scenario) => scenario.title);
    };

    const mainPlanForRepeats =
      !ready || stackSpecs.length === 0 || defaultBranch === ""
        ? Option.none<string>()
        : yield* gh([
            "api",
            `repos/${repository}/contents/e2e/test-plan.ts?ref=${defaultBranch}`,
            "-H",
            "Accept: application/vnd.github.raw+json",
          ]).pipe(
            Effect.map((text) =>
              text.includes("export const scenarios") ? Option.some(text) : Option.none<string>(),
            ),
            Effect.catch(() => Effect.succeed(Option.none<string>())),
          );
    const repeatCandidates = !ready
      ? []
      : [
          ...new Set(
            Object.entries(jobs)
              .filter(([, definition]) => "shards" in definition)
              .flatMap(([job, definition]) => jobTitles(job, definition))
              .filter(
                (title) =>
                  stackSpecs.includes(fileOf.get(title)!) &&
                  (Option.isNone(mainPlanForRepeats) || !namedIn(mainPlanForRepeats.value, title)),
              ),
          ),
        ].toSorted();
    const repeated = new Set(repeatCandidates.slice(0, repeatLimit));

    const selections = Object.entries(jobs).map(([job, definition]) => {
      const { pattern } = definition;
      const base = new RegExp(pattern);
      const titles = jobTitles(job, definition);
      const added = titles.filter((title) => !base.test(title));
      const selected =
        titles.length === 0
          ? ""
          : files === undefined
            ? added.length === 0
              ? pattern
              : `${pattern}|^(?:${added.map(escape).join("|")})$`
            : exactly(titles);
      const parts =
        !("shards" in definition) || titles.length === 0
          ? []
          : files === undefined
            ? split(titles, definition.shards, definition.target).map(exactly)
            : [selected];
      const changedTitles =
        "shards" in definition ? titles.filter((title) => repeated.has(title)) : [];
      const shards = [
        ...parts.map((part, index) => ({
          shard: `${index + 1}/${parts.length}`,
          pattern: part,
        })),
        ...(changedTitles.length === 0
          ? []
          : Array.from({ length: repeats }, (_, index) => ({
              shard: `repeat ${index + 1}/${repeats}${index === repeats - 1 ? " under load" : ""}`,
              pattern: exactly(changedTitles),
              load: index === repeats - 1 ? "true" : "",
            }))),
      ];
      const localClouds =
        job === deployedOnlyJob && titles.length > localCloudScenarios
          ? splitByCount(titles, Math.ceil(titles.length / localCloudScenarios)).map(exactly)
          : [selected];
      return {
        job,
        definition,
        count: titles.length,
        selected,
        shards,
        localClouds,
        repeated: changedTitles.length,
      };
    });
    const cloud = selections.flatMap(({ job, definition, selected, localClouds }) =>
      definition.target === "cloud" && selected !== ""
        ? localClouds.map((pattern, part) => ({
            job,
            runner: [definition.runner, part] as const,
            label: localClouds.length === 1 ? job : `${job} ${part + 1}/${localClouds.length}`,
            pattern,
          }))
        : [],
    );
    const cloudGroups = [
      ...new Map(cloud.map(({ runner }) => [runner.join("."), runner] as const)).values(),
    ]
      .sort(([a, x], [b, y]) => a - b || x - y)
      .map((runner) => {
        const on = cloud.filter((entry) => entry.runner.join(".") === runner.join("."));
        return { name: on.map(({ label }) => label).join(", "), on };
      });
    const cloudJobs = selections.flatMap(({ job, definition }) =>
      definition.target === "cloud" ? [job] : [],
    );
    const cloudRunners = cloudGroups.map(({ name, on }) => ({
      name,
      ...Object.fromEntries(
        cloudJobs.map((job) => [job, on.find((entry) => entry.job === job)?.pattern ?? ""]),
      ),
    }));
    const cloudRunnerOf = new Map(
      cloudJobs.map((job) => [
        job,
        cloudGroups
          .filter(({ on }) => on.some((entry) => entry.job === job))
          .map(({ name }) => name),
      ]),
    );
    const deployedOnlyCommand = `bun run e2e:deployed --test-name '^(?:${deployedOnlyUnrun.map(escape).join("|")})$'`;
    for (const title of deployedOnlyUnrun)
      yield* Console.log(
        `::warning title=Runs only on deployed Cloud after merge::${fileOf.get(title)}: "${title}" changed, but only a deployed stage can run it. Run it before merging: ${deployedOnlyCommand}`,
      );

    const lines = [
      ...selections.map(({ job, selected }) => `${job}=${selected}`),
      ...selections.flatMap(({ job, definition, shards }) =>
        "shards" in definition
          ? [`${job}-shards=${shards.length === 0 ? "" : JSON.stringify(shards)}`]
          : [],
      ),
      `cloud-runners=${cloudRunners.length === 0 ? "" : JSON.stringify(cloudRunners)}`,
      ...Object.entries(lanes ?? { "release-docker": [], "release-local": [] }).map(
        ([lane, matched]) => `${lane}=${matched.length > 0 ? "true" : ""}`,
      ),
      `release-docker-engine=${(engine ?? []).length > 0 ? "true" : ""}`,
      `collector=${collector}`,
      `full=${files === undefined}`,
      draftLine,
      `gate=${read === undefined ? "push" : draft === true ? "draft" : files === undefined ? "full" : "narrowed"}`,
    ].join("\n");
    const report = [
      "## E2E selection",
      "",
      files === undefined
        ? named !== undefined && "all" in named
          ? `Full suite: ${named.all}${
              draft === true
                ? "\n\nA draft does not need `all`: marking the pull request ready runs the full suite unless everything it changes is in e2e/narrowing.ts, and that run gates the merge. Name the spec files for this change instead; until then every push to this draft runs the full suite."
                : ""
            }`
          : "Full suite: this run is not for a pull request."
        : files.size === 0
          ? "No E2E scenarios: the pull request selects none and changes no spec file these jobs run."
          : `Spec files: ${[...files].sort().join(", ")}`,
      ...(read === undefined || ready
        ? []
        : [
            "",
            broad.length === 0
              ? "Once ready for review: this selection, as everything this pull request changes is in e2e/narrowing.ts."
              : `Once ready for review: the full suite, as it ${broadReason}.`,
          ]),
      ...(changedElsewhere.length === 0
        ? []
        : [
            "",
            "Changed spec files these jobs do not run:",
            ...changedElsewhere.sort().map((file) => runsElsewhere(file, suites.get(file))),
          ]),
      ...(deployedOnlyRun.size === 0
        ? []
        : [
            "",
            `Changed Cloud scenarios that otherwise run only on deployed Cloud after merge run in the ${deployedOnlyJob} job:`,
            ...[...deployedOnlyRun].sort().map((title) => `- ${fileOf.get(title)}: ${title}`),
          ]),
      ...(deployedOnlyUnrun.length === 0
        ? []
        : [
            "",
            "Changed Cloud scenarios that only a deployed stage can run, so CI first runs them in Cloud tests on main, after merge. Run them before merging:",
            "",
            `    ${deployedOnlyCommand}`,
            "",
            ...deployedOnlyUnrun.sort().map((title) => `- ${fileOf.get(title)}: ${title}`),
          ]),
      ...(guarded.length === 0
        ? []
        : ["", `A dependency patch differs from main, so its guards run: ${guarded.join(", ")}`]),
      ...(guardedByFile.length === 0
        ? []
        : ["", `A guarded file differs from main, so its guards run: ${guardedByFile.join(", ")}`]),
      ...(!collector || files === undefined
        ? []
        : [
            "",
            `A collector input changed (e2e/collector-inputs.ts), so the scenarios that exercise it run: ${collectorScenarios.join(", ")}`,
          ]),
      ...(saveChanged && files !== undefined
        ? [
            "",
            `A file a save runs or reads differs from main (e2e/save-path.ts), so these run in ${saveScenarios.job}: ${saveScenarios.files.join(", ")}`,
          ]
        : []),
      ...(searchChanged && files !== undefined
        ? [
            "",
            `A file MCP search or sessions run through differs from main (e2e/mcp-search-guard.ts), so these Cloud scenarios run too: ${[...mcpSearchTitles].join("; ")}`,
          ]
        : []),
      ...(savePathSize !== undefined
        ? ["", `The save path (e2e/save-path.ts) has ${savePathSize} files.`]
        : compared?.length === 0
          ? [
              "",
              "The save path (e2e/save-path.ts) was not read: the comparison lists no changed file, so no file a save runs or reads changed.",
            ]
          : []),
      "",
      ...(lanes === undefined
        ? ["Release lanes: none on main, where Executor releases runs the full matrix after merge."]
        : Object.entries(lanes).map(([lane, matched]) =>
            matched.length === 0
              ? `${lane}: skipped, no file it reads changed.`
              : `${lane}: runs, for ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? ` and ${matched.length - 5} more` : ""}.`,
          )),
      ...(lanes === undefined || lanes["release-docker"].length === 0
        ? []
        : [
            (engine ?? []).length === 0
              ? "release-docker runs without the packaged engine's scenarios: nothing that makes the image's engine differ changed (e2e/packaged-engine.ts). Main's paced check runs them."
              : `release-docker runs the packaged engine's scenarios, for ${engine!.slice(0, 5).join(", ")}.`,
          ]),
      "",
      collector
        ? "collector-native: runs (e2e/collector-inputs.ts)."
        : "collector-native: skipped, no collector input changed (e2e/collector-inputs.ts).",
      "",
      ...selections
        .filter(({ repeated }) => repeated > 0)
        .map(
          ({ job, repeated }) =>
            `${job}: ${repeated} new scenarios run ${repeats} more times, the last with half the cores busy; any failure fails the pull request.`,
        ),
      ...(repeatCandidates.length > repeatLimit
        ? [
            `Only ${repeatLimit} of the ${repeatCandidates.length} new scenarios repeat (the first by title), so the outputs stay bounded: ${Option.isNone(mainPlanForRepeats) ? "main's plan could not be read, so every scenario of a changed spec file counted as new" : "split the change to repeat the rest"}.`,
          ]
        : []),
      ...(selections.some(({ repeated }) => repeated > 0) ? [""] : []),
      "| Job | Scenarios | Runners |",
      "| --- | --- | --- |",
      ...selections.map(({ job, definition, count, shards, localClouds, repeated }) =>
        count === 0
          ? `| ${job} | skipped | |`
          : `| ${job} | ${count} | ${
              definition.target === "cloud"
                ? `${(cloudRunnerOf.get(job) ?? []).map((name) => `e2e-cloud (${name})`).join(", ")}${
                    localClouds.length > 1
                      ? `: ${localClouds.length} local Clouds split by spec file`
                      : ""
                  }`
                : shards.length - (repeated > 0 ? repeats : 0) > 1
                  ? `${shards.length - (repeated > 0 ? repeats : 0)}, split by spec file`
                  : "1"
            } |`,
      ),
      "",
    ].join("\n");
    yield* Console.log(report);
    if (Option.isSome(output))
      yield* fs.writeFileString(output.value, keyed(lines, read?.body), { flag: "a" });
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
