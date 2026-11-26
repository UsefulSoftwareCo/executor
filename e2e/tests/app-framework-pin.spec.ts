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
const release = "0.0.1-beta.2";
const catchUpStep = "2_app_framework_pin_catch_up";
const catchUpRelease = "0.0.1-beta.5";

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
  activeVersion: Schema.NullOr(Schema.String),
});
type App = typeof App.Type;
const Deployed = Schema.Struct({ app: App });
const RunningSource = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

interface Surface {
  readonly owner: string;
  readonly deploy: (name: string, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly redeploy: (app: App, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly deployCommit: (app: App, commit: string) => Effect.Effect<App, unknown, Api>;
  readonly create: (name: string, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly get: (app: App) => Effect.Effect<App, unknown, Api>;
  readonly workspace: (app: App) => Effect.Effect<typeof Workspace.Type, unknown, Api>;
  readonly commit: (app: App, files: Files, message: string) => Effect.Effect<void, unknown, Api>;
  readonly framework: (app: App) => Effect.Effect<string, unknown, Api>;
  readonly executorApp: Effect.Effect<App, unknown, Api>;
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
    const restart = Effect.gen(function* () {
      const seen = yield* summaries;
      yield* serverControl("restart");
      return yield* nextDataStepSummary(log, step, seen);
    });

    expect(yield* nextDataStepSummary(log, step, 0)).toMatchObject({
      mode: "report",
      status: "complete",
    });

    const packaged = yield* track(surface.deploy(unique("Packaged"), deployedFiles("first")));
    yield* surface.commit(
      packaged,
      [index("first"), { path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` }],
      "Drop the declaration",
    );
    const contended = yield* track(surface.deploy(unique("Contended"), deployedFiles("first")));
    yield* surface.commit(contended, [index("first")], "Single file");
    const unpublished = yield* track(surface.deploy(unique("Unpublished"), deployedFiles("first")));
    yield* surface.commit(unpublished, [index("unpublished")], "Unpublished edit");
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

    const lock = `${repositories}/${contended.code}.git/refs/heads/main.lock`;
    yield* fs.writeFileString(lock, "");
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
    const catchUpApplied = dataStepSummaries(log, catchUpStep).pipe(
      Effect.map((all) => all.filter((summary) => summary.mode === "apply")),
    );
    expect(yield* catchUpApplied).toEqual([]);
    const late = yield* track(surface.create(unique("Late"), [index("late")]));

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
    const packagedFiles = (yield* surface.workspace(packaged)).files;
    expect(packagedFiles.find((file) => file.path === "package.json")?.content).toBe(
      `${JSON.stringify({ ...manifest, dependencies: { apps: release } }, null, 2)}\n`,
    );
    expect((yield* surface.workspace(executorApp)).files).toEqual(pinnedFiles(executorFiles));
    for (const app of [declared, invalid, contended])
      expect((yield* surface.workspace(app)).revision.commit, app.name).toBe(
        before[apps.indexOf(app)],
      );

    expect(yield* Effect.forEach(apps, surface.get)).toEqual(running);
    expect(yield* surface.framework(diverged)).toBe("beta.0");

    yield* fs.remove(lock);
    const retried = yield* restart;
    expect(retried).toMatchObject({ mode: "apply", run: "apply", status: "complete", pass: 2 });
    expect(retried.owners[surface.owner]).toEqual({
      ...appliedCounts,
      "pinned-unpublished": appliedCounts["pinned-unpublished"] + 1,
    });
    expect((yield* surface.workspace(contended)).files).toEqual(pinnedFiles([index("first")]));
    expect((yield* history(contended))[1]?.commit).toBe(before[apps.indexOf(contended)]);
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

    const settled = yield* revisions;
    const quiet = yield* summaries;
    yield* serverControl("restart");
    expect(yield* summaries).toBe(quiet);
    expect(yield* revisions).toEqual(settled);

    if (local) expect(declaredApps(yield* surface.running(executorApp))).toBe(appsVersion);
    for (const app of [contended, diverged, executorApp, late]) {
      yield* surface.deployCommit(app, (yield* surface.workspace(app)).revision.commit);
      expect(yield* surface.framework(app), app.name).toBe("dynamicTools");
    }
  });

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
    const waiting = telemetry
      .searchWholeEnvironment("data_step.advance", {
        "data_step.name": step,
        "data_step.status": "waiting",
      })
      .pipe(Effect.map((found) => new Set(found.data.map(({ traceId }) => traceId))));
    const dispatches = (attributes: Readonly<Record<string, string>>) =>
      telemetry.searchWholeEnvironment("job.dispatch", {
        "executor.job": "data-steps",
        ...attributes,
      });
    const tick = Effect.scoped(
      http
        .get(
          `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
        )
        .pipe(Effect.flatMap((response) => response.text)),
    );
    const retryAt = (pass: DataStepPass) => Date.parse(pass.summary.retryAt ?? "");
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

    const logged = (yield* passes).length;
    const dispatched = new Set((yield* dispatches({})).data.map(({ traceId }) => traceId));
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
    expect(started.summary.owners[surface.owner]).toEqual({ failed: 2 });
    const failedTicks = yield* dispatches({ "executor.job.failure": "DataStepItemFailed" }).pipe(
      Effect.flatMap((found) => {
        const fresh = found.data.filter(({ traceId }) => !dispatched.has(traceId));
        return fresh.length === 0
          ? Effect.fail(new Error("No dispatch with failed items has reached the collector"))
          : Effect.succeed(fresh);
      }),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
    );
    for (const { span } of failedTicks) {
      expect(["partial", "failed"]).toContain(span.tags["executor.outcome"]);
      expect(span.tags["http.response.status_code"]).toBe("204");
    }

    expect(
      retryAt(started) - Date.now(),
      "The first pass's backoff has already passed",
    ).toBeGreaterThan(5_000);
    const waited = yield* waiting;
    const before = (yield* ofRun).length;
    yield* tick;
    const waitingTrace = yield* waiting.pipe(
      Effect.flatMap((traces) => {
        const fresh = [...traces].find((trace) => !waited.has(trace));
        return fresh === undefined
          ? Effect.fail(new Error("No waiting tick delivered yet"))
          : Effect.succeed(fresh);
      }),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    );
    expect((yield* ofRun).length).toBe(before);
    const waitingDispatch = yield* telemetry.query(waitingTrace).pipe(
      Effect.flatMap((trace) => {
        const dispatch = trace.data.find(
          ({ span }) =>
            span.operationName === "job.dispatch" && span.tags["executor.job"] === "data-steps",
        );
        return dispatch === undefined
          ? Effect.fail(new Error("The waiting tick's dispatch has not arrived"))
          : Effect.succeed(dispatch.span);
      }),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    );
    expect(waitingDispatch.status).not.toBe("error");
    expect(waitingDispatch.tags).toMatchObject({
      "http.response.status_code": "204",
      "executor.outcome": "completed",
    });
    expect(waitingDispatch.tags).not.toHaveProperty("executor.job.failure");

    yield* Effect.sleep(Duration.millis(Math.max(0, retryAt(started) - Date.now())));
    const next = yield* advanceUntil((all) =>
      all.slice(first).find((pass) => pass.summary.run === run && pass.summary.pass === 2),
    );
    expect(next.summary).toMatchObject({ run, pass: 2, status: "retrying" });
    expect(next.summary.owners[surface.owner]).toEqual({ failed: 2 });

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
    { timeout: 180_000 },
  );
});
