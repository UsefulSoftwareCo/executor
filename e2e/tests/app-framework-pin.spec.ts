/**
 * The `1_app_framework_pin` data step commits `dependencies.apps` to every existing app without
 * redeploying it. Local and self-host run it at startup; this scenario starts its product with the
 * step held in report mode and gives apps every position whose `main` lacks a declaration. This
 * host builds only declared source, so the running deployments declare the published beta.0.
 * Positions whose running build has no declaration need a host that built undeclared source, and
 * are not reproduced here. It then applies the step and checks the report, the pins, a conflict
 * retried at the next start, the catch-up step pinning an app created meanwhile to beta.5, a later
 * start that changes nothing, and that pinned apps, the Executor app included, rebuild on their
 * pinned release from before routers. Cloud runs the step from the
 * Worker's cron after deploy and reports until told to apply.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { Committed, Workspace } from "../support/app-authoring.ts";
import { serverControl } from "../support/server-control.ts";
import {
  dataStepPasses,
  dataStepSummaries,
  nextDataStepSummary,
  type DataStepPass,
} from "../support/data-steps.ts";
import { Telemetry } from "../support/evidence.ts";
import { appsVersion, declaredApps } from "../support/apps-release.ts";

const step = "1_app_framework_pin";
/** The protocol-1 release the step pins, resolved from npm like every published release. */
const release = "0.0.1-beta.2";
const catchUpStep = "2_app_framework_pin_catch_up";
/** The last release before routers, which the catch-up step pins. */
const catchUpRelease = "0.0.1-beta.5";

/**
 * Source written for the protocol-1 framework every app ran before routers. It reports which
 * framework its build runs: beta.1 added `dynamicTools` to beta.0, and routers replaced both. Later
 * releases before routers, including both pinned ones, report `dynamicTools`.
 */
const index = (revision: string) => ({
  path: "index.ts",
  content: `import * as apps from "apps";
import { defineApp, query, object } from "apps";
// ${revision}
export default defineApp({ accounts: {} }, {
  queries: { framework: query({ input: object({}) }, async () => ("router" in apps ? "routers" : "dynamicTools" in apps ? "dynamicTools" : "beta.0")) },
});`,
});
const manifest = { name: "pin-fixture", private: true, type: "module", dependencies: {} };
const pinnedManifest = `${JSON.stringify({ dependencies: { apps: release } }, null, 2)}\n`;
/** Files a running deployment builds: the source, declaring the published protocol-1 beta.0. */
const deployedFiles = (revision: string) => [
  index(revision),
  {
    path: "package.json",
    content: `${JSON.stringify({ ...manifest, dependencies: { apps: "0.0.1-beta.0" } }, null, 2)}\n`,
  },
];

type Files = readonly { readonly path: string; readonly content: string }[];
type Reply = { readonly status: number; readonly body: unknown };
const App = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  name: Schema.String,
  activeDeployment: Schema.NullOr(Schema.String),
});
type App = typeof App.Type;
const Deployed = Schema.Struct({ app: App });
const RunningSource = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

/** The same app operations through each product's own API. */
interface Surface {
  /** The owner ID the step reports for this scenario's apps. */
  readonly owner: string;
  readonly deploy: (name: string, files: Files) => Effect.Effect<App, unknown, Api>;
  /** A direct file deploy of an existing app, which never writes Git. */
  readonly redeploy: (app: App, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly deployCommit: (app: App, commit: string) => Effect.Effect<App, unknown, Api>;
  readonly create: (name: string, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly get: (app: App) => Effect.Effect<App, unknown, Api>;
  readonly workspace: (app: App) => Effect.Effect<typeof Workspace.Type, unknown, Api>;
  readonly commit: (app: App, files: Files, message: string) => Effect.Effect<void, unknown, Api>;
  readonly framework: (app: App) => Effect.Effect<string, unknown, Api>;
  readonly executorApp: Effect.Effect<App, unknown, Api>;
  /** The files of the running deployment. */
  readonly running: (app: App) => Effect.Effect<Files, unknown, Api>;
  readonly cleanup: (app: App) => Effect.Effect<unknown, unknown, Api>;
}

const decoded =
  <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  (response: Reply) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return body(schema, response);
  };

const hostedSurface = (actor: Session, organization: string): Surface => {
  const prefix = `/api/organizations/${organization}`;
  const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
    Api.pipe(Effect.flatMap((api) => api.request(actor, method, `${prefix}${path}`, data)));
  const deployed = (path: string, data: unknown) =>
    request("POST", path, data).pipe(
      Effect.flatMap(decoded(Deployed)),
      Effect.map((result) => result.app),
    );
  const surface: Surface = {
    owner: `organization:${organization}`,
    deploy: (name, files) =>
      request("POST", "/apps/deploy", { name, files }).pipe(Effect.flatMap(decoded(App))),
    redeploy: (target, files) => deployed(`/apps/${target.id}/deploy`, { files }),
    deployCommit: (target, commit) => deployed(`/apps/${target.id}/deploy`, { commit }),
    create: (name, files) =>
      request("POST", "/apps", { name, files }).pipe(Effect.flatMap(decoded(App))),
    get: (target) => request("GET", `/apps/${target.id}`).pipe(Effect.flatMap(decoded(App))),
    workspace: (target) =>
      request("GET", `/apps/${target.id}/workspace`).pipe(Effect.flatMap(decoded(Workspace))),
    commit: (target, files, message) =>
      Effect.gen(function* () {
        const source = yield* surface.workspace(target);
        yield* request("POST", `/apps/${target.id}/commits`, {
          expected: source.revision.commit,
          files,
          message,
        }).pipe(Effect.flatMap(decoded(Committed)));
      }),
    framework: (target) =>
      request("POST", `/apps/${target.id}/tools/call`, {
        tool: "queries.framework",
        input: {},
      }).pipe(Effect.flatMap(decoded(Schema.String))),
    executorApp: request("GET", "/apps").pipe(
      Effect.flatMap(decoded(Schema.Array(App))),
      Effect.flatMap((apps) => Effect.fromNullishOr(apps.find((app) => app.name === "Executor"))),
    ),
    running: (target) =>
      request("GET", `/apps/${target.id}/source`).pipe(
        Effect.flatMap(decoded(RunningSource)),
        Effect.map((source) => source.files),
      ),
    cleanup: (target) => request("DELETE", `/apps/${target.id}`),
  };
  return surface;
};

/** Local's agent API takes the host-issued key and refuses browser-origin requests. */
const localSurface = (session: Session, apiKey: string): Surface => {
  const agent: Session = {
    ...session,
    send: (method, path, data, headers = {}) => {
      const { origin: _origin, ...agentHeaders } = headers;
      return session.send(method, path, data, {
        ...agentHeaders,
        authorization: `Bearer ${apiKey}`,
      });
    },
  };
  const owner = "local";
  const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
    Api.pipe(Effect.flatMap((api) => api.request(agent, method, path, data)));
  const deployed = (data: unknown) =>
    request("POST", "/v1/apps/deploy", data).pipe(
      Effect.flatMap(decoded(Deployed)),
      Effect.map((result) => result.app),
    );
  const ownerOf = (target: App) => (target.name === "Executor" ? "executor-local" : owner);
  const surface: Surface = {
    owner,
    deploy: (name, files) => deployed({ owner, name, files }),
    redeploy: (target, files) => deployed({ owner: ownerOf(target), app: target.id, files }),
    deployCommit: (target, commit) => deployed({ owner: ownerOf(target), app: target.id, commit }),
    create: (name, files) =>
      request("POST", "/v1/apps", { owner, name, files }).pipe(Effect.flatMap(decoded(App))),
    get: (target) =>
      request("GET", `/v1/apps/${target.id}?owner=${ownerOf(target)}`).pipe(
        Effect.flatMap(decoded(App)),
      ),
    workspace: (target) =>
      request("GET", `/v1/apps/${target.id}/workspace?owner=${ownerOf(target)}`).pipe(
        Effect.flatMap(decoded(Workspace)),
      ),
    commit: (target, files, message) =>
      Effect.gen(function* () {
        const source = yield* surface.workspace(target);
        yield* request("POST", `/v1/apps/${target.id}/commits`, {
          owner: ownerOf(target),
          expected: source.revision.commit,
          files,
          message,
        }).pipe(Effect.flatMap(decoded(Committed)));
      }),
    framework: (target) =>
      request("POST", "/v1/tools/call", {
        app: target.id,
        tool: "queries.framework",
        input: {},
      }).pipe(
        Effect.flatMap(
          decoded(Schema.Struct({ status: Schema.Literal("completed"), value: Schema.String })),
        ),
        Effect.map((result) => result.value),
      ),
    executorApp: request("GET", "/v1/apps?owner=executor-local&name=Executor").pipe(
      Effect.flatMap(decoded(Schema.Array(App))),
      Effect.flatMap((apps) => Effect.fromNullishOr(apps[0])),
    ),
    running: (target) =>
      request("GET", `/v1/apps/${target.id}/source?owner=${ownerOf(target)}`).pipe(
        Effect.flatMap(decoded(RunningSource)),
        Effect.map((source) => source.files),
      ),
    cleanup: (target) => request("DELETE", `/v1/apps/${target.id}?owner=${owner}`),
  };
  return surface;
};

/** The pin on a product whose startup runs data steps: local or self-host. */
const startupPin = (surface: Surface) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const fs = yield* FileSystem.FileSystem;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const log = `${target.directory}/server.log`;
    const repositories = `${target.directory}/data/repositories`;
    const local = target.metadata.target === "local";
    const created: App[] = [];
    yield* Effect.addFinalizer(() => Effect.forEach(created, surface.cleanup).pipe(Effect.ignore));
    const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;
    const track = <E, R>(effect: Effect.Effect<App, E, R>) =>
      effect.pipe(Effect.tap((app) => Effect.sync(() => created.push(app))));
    /** The last two commits on main, read from the app's repository as any Git client would. */
    const history = (app: App) =>
      processes
        .string(
          ChildProcess.make("git", [
            "--git-dir",
            `${repositories}/${app.code}.git`,
            "log",
            "-2",
            "--format=%an%x1f%H%x1f%B%x1e",
            "main",
          ]),
        )
        .pipe(
          Effect.map((text) =>
            text
              .split("\x1e")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
              .map((entry) => {
                const [author, commit, message] = entry.split("\x1f");
                return { author, commit, message };
              }),
          ),
        );
    const summaries = dataStepSummaries(log, step).pipe(Effect.map((all) => all.length));
    /** Restart and return the summary the new start logged for the step. */
    const restart = Effect.gen(function* () {
      const seen = yield* summaries;
      yield* serverControl("restart");
      return yield* nextDataStepSummary(log, step, seen);
    });

    // The product started with the step held, so it reported before this scenario had apps.
    expect(yield* nextDataStepSummary(log, step, 0)).toMatchObject({
      mode: "report",
      status: "complete",
    });

    // Apps in every position against their running deployment whose main declares no framework.
    // A manifest that dropped its declaration after the running build.
    const packaged = yield* track(surface.deploy(unique("Packaged"), deployedFiles("first")));
    yield* surface.commit(
      packaged,
      [index("first"), { path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` }],
      "Drop the declaration",
    );
    // A single-file main; another writer holds it when the pin is applied.
    const contended = yield* track(surface.deploy(unique("Contended"), deployedFiles("first")));
    yield* surface.commit(contended, [index("first")], "Single file");
    // Main moved on from the running source without deploying.
    const unpublished = yield* track(surface.deploy(unique("Unpublished"), deployedFiles("first")));
    yield* surface.commit(unpublished, [index("unpublished")], "Unpublished edit");
    // Main has an undeployed edit and the running source came from other files.
    const diverged = yield* track(surface.deploy(unique("Diverged"), deployedFiles("first")));
    yield* surface.commit(diverged, [index("saved")], "Saved edit");
    yield* surface.redeploy(diverged, deployedFiles("deployed instead"));
    const undeployed = yield* track(surface.create(unique("Undeployed"), [index("first")]));
    const declared = yield* track(
      surface.create(unique("Declared"), [
        index("first"),
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: "0.0.1-beta.0" } }),
        },
      ]),
    );
    const invalid = yield* track(
      surface.create(unique("Invalid manifest"), [
        index("first"),
        { path: "package.json", content: "[]" },
      ]),
    );
    // The host-managed Executor app with protocol-1 source and no declaration on main, like every
    // copy made before templates declared one. Its running deployment is the template's.
    const executorApp = yield* surface.executorApp;
    const executorFiles = [index("executor")];
    yield* surface.commit(executorApp, executorFiles, "Edit the Executor app");

    const apps = [packaged, contended, unpublished, diverged, undeployed, declared, invalid];
    const read = Effect.forEach(apps, surface.workspace);
    const revisions = read.pipe(
      Effect.map((sources) => sources.map((source) => source.revision.commit)),
    );
    const before = yield* revisions;
    const running = yield* Effect.forEach(apps, surface.get);

    // Report: counts per outcome and owner, and nothing written.
    const report = yield* restart;
    expect(report).toMatchObject({ mode: "report", status: "complete", pass: 1 });
    expect(report.owners[surface.owner]).toEqual({
      "pin-unpublished": local ? 3 : 4,
      "pin-diverged": 1,
      "pin-undeployed": 1,
      declared: 1,
      "invalid-manifest": 1,
    });
    if (local) expect(report.owners["executor-local"]).toEqual({ "pin-unpublished": 1 });
    expect(yield* revisions).toEqual(before);

    // Apply while another writer holds one app's main: that app conflicts and is retried.
    const lock = `${repositories}/${contended.code}.git/refs/heads/main.lock`;
    yield* fs.writeFileString(lock, "");
    // This release requires a declaration to build; the step runs at start, before anything builds.
    yield* serverControl("stop");
    yield* serverControl("data-steps", 200, { mode: "apply" });
    const seen = yield* summaries;
    yield* serverControl("start");
    const applied = yield* nextDataStepSummary(log, step, seen);
    const appliedCounts = {
      "pinned-unpublished": local ? 2 : 3,
      "pinned-diverged": 1,
      "pinned-undeployed": 1,
      declared: 1,
      "invalid-manifest": 1,
    };
    expect(applied).toMatchObject({ mode: "apply", run: "apply", status: "retrying", pass: 1 });
    expect(applied.owners[surface.owner]).toEqual({ ...appliedCounts, conflict: 1 });
    if (local) expect(applied.owners["executor-local"]).toEqual({ "pinned-unpublished": 1 });
    // The catch-up step waits while the first retries. An app created now, without a declaration,
    // is outside the first step's retry pass; only the catch-up step pins it.
    const catchUpApplied = dataStepSummaries(log, catchUpStep).pipe(
      Effect.map((all) => all.filter((summary) => summary.mode === "apply")),
    );
    expect(yield* catchUpApplied).toEqual([]);
    const late = yield* track(surface.create(unique("Late"), [index("late")]));

    // Every position is pinned on top of main, as an Executor commit on the revision it read.
    // Git returns files in path order.
    const pinnedFiles = (files: Files) =>
      [
        ...files.filter((file) => file.path !== "package.json"),
        { path: "package.json", content: pinnedManifest },
      ].toSorted((left, right) => (left.path < right.path ? -1 : 1));
    for (const [app, files] of [
      [unpublished, [index("unpublished")]],
      [diverged, [index("saved")]],
      [undeployed, [index("first")]],
    ] as const) {
      const pinned = yield* surface.workspace(app);
      expect(pinned.files, app.name).toEqual(pinnedFiles(files));
      const [head, parent] = yield* history(app);
      expect(head, app.name).toMatchObject({
        author: "Executor",
        commit: pinned.revision.commit,
        message: expect.stringContaining(`Pin the apps framework to ${release}`),
      });
      expect(parent?.commit, app.name).toBe(before[apps.indexOf(app)]);
    }
    // An existing manifest keeps every field, its order and its formatting.
    const packagedFiles = (yield* surface.workspace(packaged)).files;
    expect(packagedFiles.find((file) => file.path === "package.json")?.content).toBe(
      `${JSON.stringify({ ...manifest, dependencies: { apps: release } }, null, 2)}\n`,
    );
    expect((yield* surface.workspace(executorApp)).files).toEqual(pinnedFiles(executorFiles));
    // Declared, invalid and contended apps are unchanged.
    for (const app of [declared, invalid, contended])
      expect((yield* surface.workspace(app)).revision.commit, app.name).toBe(
        before[apps.indexOf(app)],
      );

    // Nothing was redeployed: running deployments keep serving the framework they were built with.
    expect(yield* Effect.forEach(apps, surface.get)).toEqual(running);
    expect(yield* surface.framework(diverged)).toBe("beta.0");

    // The next start retries only the conflicted app, then records the step as applied.
    yield* fs.remove(lock);
    const retried = yield* restart;
    expect(retried).toMatchObject({ mode: "apply", run: "apply", status: "complete", pass: 2 });
    expect(retried.owners[surface.owner]).toEqual({
      ...appliedCounts,
      "pinned-unpublished": appliedCounts["pinned-unpublished"] + 1,
    });
    expect((yield* surface.workspace(contended)).files).toEqual(pinnedFiles([index("first")]));
    expect((yield* history(contended))[1]?.commit).toBe(before[apps.indexOf(contended)]);
    // The catch-up step runs once the first completes. Everything the first pinned reads as
    // declared; the late app is pinned to the last release before routers.
    const catchUp = (yield* catchUpApplied).at(-1);
    expect(catchUp).toMatchObject({ mode: "apply", run: "apply", status: "complete", pass: 1 });
    expect(catchUp?.owners[surface.owner]).toEqual({
      declared: local ? 6 : 7,
      "invalid-manifest": 1,
      "pinned-undeployed": 1,
    });
    if (local) expect(catchUp?.owners["executor-local"]).toEqual({ declared: 1 });
    const lateSource = yield* surface.workspace(late);
    expect(lateSource.files).toEqual([
      index("late"),
      {
        path: "package.json",
        content: `${JSON.stringify({ dependencies: { apps: catchUpRelease } }, null, 2)}\n`,
      },
    ]);
    expect((yield* history(late))[0]).toMatchObject({
      author: "Executor",
      commit: lateSource.revision.commit,
      message: expect.stringContaining(`Pin the apps framework to ${catchUpRelease}`),
    });

    // A later start runs nothing and changes nothing.
    const settled = yield* revisions;
    const quiet = yield* summaries;
    yield* serverControl("restart");
    expect(yield* summaries).toBe(quiet);
    expect(yield* revisions).toEqual(settled);

    // Local regenerated its Executor app from the router template, which declares this host's
    // release; main keeps the pinned source.
    if (local) expect(declaredApps(yield* surface.running(executorApp))).toBe(appsVersion);
    // The next deploy of a pinned app, the Executor app included, resolves the declared
    // release from before routers, so its source keeps building and running on the router host.
    for (const app of [contended, diverged, executorApp, late]) {
      yield* surface.deployCommit(app, (yield* surface.workspace(app)).revision.commit);
      expect(yield* surface.framework(app), app.name).toBe("dynamicTools");
    }
  });

/**
 * Cloud runs the step from the Worker's minute cron after deploy, and reports until told to apply.
 * The local Worker's own cron advances it too, and the scenario ticks it through the scheduled-event
 * route. Every deploy resumes one report run, `report:cloud`, rather than starting one per build:
 * production deploys more often than a pass over every app takes. A run's first pass visits every
 * app and later passes revisit only the apps it left to retry, so the managed Cloud's run, started
 * before this scenario, never visits this scenario's apps. The scenario restarts the run once its
 * app exists, as a deploy that sets a new report label would. The local Worker cannot reach
 * Cloudflare Artifacts, so this organization's apps report `failed` and keep the run retrying while
 * the scenario observes it. Each retrying pass records its next start, 30 seconds after the first
 * pass and doubling; no pass starts before the previous one's time, and a tick before it starts
 * none. Nothing is ever applied.
 */
const cloudReport = (surface: Surface) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const http = yield* HttpClient.HttpClient;
    const telemetry = yield* Telemetry;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const log = `${target.directory}/cloud.log`;
    const run = "report:cloud";
    const app = yield* surface.deploy(
      `Cloud pin ${randomUUID().slice(0, 8)}`,
      deployedFiles("cloud"),
    );
    yield* Effect.addFinalizer(() => surface.cleanup(app).pipe(Effect.ignore));
    const passes = dataStepPasses(log, step);
    // Delivered `data_step.advance` spans of ticks that found the step waiting out its backoff.
    const waiting = telemetry
      .spans("data_step.advance", { "data_step.name": step, "data_step.status": "waiting" })
      .pipe(Effect.map((spans) => spans.length));
    const tick = Effect.scoped(
      http
        .get(
          `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
        )
        .pipe(Effect.flatMap((response) => response.text)),
    );
    const retryAt = (pass: DataStepPass) => Date.parse(pass.summary.retryAt ?? "");
    /**
     * Tick until the log holds the pass `find` picks. A tick's invocation ends with its job, and
     * a pass that outlasts one tick's budget resumes at the next tick, so ticks never overlap and
     * each advances the pass. A tick that finds the run held by the Worker's own cron starts nothing.
     */
    const advanceUntil = <A>(find: (all: ReadonlyArray<DataStepPass>) => A | undefined) =>
      tick.pipe(
        Effect.andThen(passes),
        Effect.flatMap((all) => {
          const found = find(all);
          return found === undefined
            ? Effect.fail(new Error("The pass has not finished"))
            : Effect.succeed(found);
        }),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
      );

    // Restart the run now that this scenario's app exists, once no pass holds it.
    const logged = (yield* passes).length;
    const restart = yield* processes
      .string(
        ChildProcess.make(
          "node",
          [
            "apps/hosted/testing/data-step-report-fixture.ts",
            "--configuration",
            `${target.directory}/sso-database.json`,
            "--step",
            step,
            "--run",
            run,
          ],
          { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
        ),
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ restarted: Schema.Boolean, held: Schema.Boolean }),
            ),
          ),
        ),
        Effect.repeat({
          until: (state) => !state.held,
          schedule: Schedule.spaced("500 millis"),
          times: 60,
        }),
      );
    expect(restart.held, "A pass still holds the report run").toBe(false);

    // The restarted run's first pass visits every app, this organization's among them. A pass of
    // the previous run can log its summary just after releasing the run, so the first pass is found
    // by its owners.
    const first = yield* advanceUntil((all) => {
      const index = all
        .slice(logged)
        .findIndex(
          (pass) => pass.summary.pass === 1 && pass.summary.owners[surface.owner] !== undefined,
        );
      return index < 0 ? undefined : logged + index;
    });
    const ofRun = passes.pipe(
      Effect.map((all) => all.slice(first).filter((pass) => pass.summary.run === run)),
    );
    const [started] = yield* ofRun;
    if (started === undefined)
      return yield* Effect.die("Missing the restarted report's first pass");
    expect(started.summary).toMatchObject({ mode: "report", run, pass: 1, status: "retrying" });
    expect(started.summary.run, "The report is not labelled with the build").not.toContain(
      target.metadata.commit,
    );
    // This app and the organization's Executor app.
    expect(started.summary.owners[surface.owner]).toEqual({ failed: 2 });

    // A tick before the first pass's retry time finds the step waiting and starts no pass.
    expect(
      retryAt(started) - Date.now(),
      "The first pass's backoff has already passed",
    ).toBeGreaterThan(5_000);
    const waited = yield* waiting;
    const before = (yield* ofRun).length;
    yield* tick;
    yield* waiting.pipe(
      Effect.flatMap((count) =>
        count > waited ? Effect.void : Effect.fail(new Error("No waiting tick delivered yet")),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    );
    expect((yield* ofRun).length).toBe(before);

    // Once it passes, the next tick starts the next pass. The Worker's own cron may start it first.
    yield* Effect.sleep(Duration.millis(Math.max(0, retryAt(started) - Date.now())));
    const next = yield* advanceUntil((all) =>
      all.slice(first).find((pass) => pass.summary.run === run && pass.summary.pass === 2),
    );
    expect(next.summary).toMatchObject({ run, pass: 2, status: "retrying" });
    expect(next.summary.owners[surface.owner]).toEqual({ failed: 2 });

    // Every retrying pass backs off 30 seconds doubled for each earlier pass, and the next pass
    // never started before that time. Log and database clocks agree to within a second here.
    const history = yield* ofRun;
    expect(history.length).toBeGreaterThanOrEqual(2);
    for (const [index, pass] of history.entries()) {
      expect(pass.summary.status).toBe("retrying");
      const delay = retryAt(pass) - (pass.loggedAt ?? Number.NaN);
      const expected = Math.min(3_600_000, 30_000 * 2 ** (pass.summary.pass - 1));
      expect(delay, `pass ${pass.summary.pass}`).toBeGreaterThan(expected - 2_000);
      expect(delay, `pass ${pass.summary.pass}`).toBeLessThanOrEqual(expected + 1_000);
      const previous = history[index - 1];
      if (previous !== undefined) {
        expect(pass.summary.pass).toBe(previous.summary.pass + 1);
        expect(pass.loggedAt ?? 0).toBeGreaterThanOrEqual(retryAt(previous) - 1_000);
      }
      for (const outcome of Object.keys(pass.summary.outcomes))
        expect(outcome).not.toMatch(/^pinned|^conflict$/);
    }
  });

layer(HostedLive, { excludeTestServices: true })("Framework pin data step", (it) => {
  it.effect(
    scenarios.appFrameworkPin.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors;
          return yield* startupPin(hostedSurface(actors.owner, actors.organization.id));
        }),
      ),
    // The product starts five times: held, a report, the apply, the retry and a quiet start.
    { timeout: 120_000 },
  );
  it.effect(
    scenarios.localAppFrameworkPin.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const target = yield* Target;
          return yield* startupPin(
            localSurface(yield* api.session(), Redacted.value(target.apiKey)),
          );
        }),
      ),
    // The product starts five times: held, a report, the apply, the retry and a quiet start.
    { timeout: 120_000 },
  );
  it.effect(
    scenarios.cloudAppFrameworkPin.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors;
          return yield* cloudReport(hostedSurface(actors.owner, actors.organization.id));
        }),
      ),
    // The next pass can wait out up to a minute of backoff.
    { timeout: 180_000 },
  );
});
