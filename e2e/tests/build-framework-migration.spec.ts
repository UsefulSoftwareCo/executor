/**
 * The `3_build_framework_once` data step splits builds retained with their `apps` framework
 * inlined in `<build>.json` into `<build>/worker.json` and a framework stored once. Self-host and
 * local run it at startup. The scenario starts its product with data steps held in report mode,
 * deploys apps, then stops the product and rewrites their builds on disk in the inlined shape every
 * host wrote before the split: one active, one replaced by a later deploy, one on an older release
 * whose framework object is removed, and one whose `<build>.json` is corrupt. A report start writes
 * nothing; an apply start splits every readable build, records the corrupt one as `invalid`, and
 * keeps every `<build>.json`; the apps keep working; and a later report finds everything split.
 * Cloud runs the same step from the Worker's cron; its report and apply are reviewed in production.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { dataStepSummaries, nextDataStepSummary } from "../support/data-steps.ts";
import { appsManifest, appsVersion } from "../support/apps-release.ts";

const step = "3_build_framework_once";
/** A published release before routers, whose framework the step labels from the release table. */
const olderRelease = "0.0.1-beta.5";

type Files = readonly { readonly path: string; readonly content: string }[];
const current = (marker: string): Files => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object, string, router } from "apps";
export const ping = query({ input: object({}), output: string() }, async () => ${JSON.stringify(marker)});
export default defineApp({}, { tools: router({ ping }) });`,
  },
  appsManifest,
];
// app-user-accounts: keep, as source of an earlier `apps` release.
const older = (marker: string): Files => [
  {
    path: "index.ts",
    content: `import { defineApp, query, object } from "apps";
const ping = query({ input: object({}) }, async () => ${JSON.stringify(marker)});
export default defineApp({ accounts: {} }, { queries: { ping } });`,
  },
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: olderRelease } }) },
];

const App = Schema.Struct({ id: Schema.String, name: Schema.String });
type App = typeof App.Type;
const Deployed = Schema.Struct({ app: App });
const Source = Schema.Struct({ build: Schema.String });
const Identity = Schema.Struct({ version: Schema.String, sha256: Schema.String });
type Identity = typeof Identity.Type;
/** The split record, decoded only as far as the scenario reads it. */
const SplitRecord = Schema.fromJsonString(
  Schema.Struct({
    format: Schema.Literal(2),
    modules: Schema.Record(Schema.String, Schema.Unknown),
    framework: Identity,
  }),
);
const StoredFramework = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    sha256: Schema.String,
    modules: Schema.Record(Schema.String, Schema.String),
  }),
);
/** Encoded JSON objects, rewritten without decoding module contents. */
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const Modules = Schema.Record(Schema.String, Schema.Unknown);

/** The same app operations through each product's own API. */
interface Surface {
  readonly deploy: (name: string, files: Files) => Effect.Effect<App, unknown, Api>;
  readonly redeploy: (app: App, files: Files) => Effect.Effect<void, unknown, Api>;
  /** The running deployment's build. */
  readonly build: (app: App) => Effect.Effect<string, unknown, Api>;
  readonly call: (app: App, tool: string) => Effect.Effect<unknown, unknown, Api>;
  readonly cleanup: (app: App) => Effect.Effect<unknown, unknown, Api>;
}

const ok =
  <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  (response: { readonly status: number; readonly body: unknown }) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return body(schema, response);
  };

const hostedSurface = (actor: Session, organization: string): Surface => {
  const prefix = `/api/organizations/${organization}`;
  const request = (method: "GET" | "POST" | "DELETE", path: string, data?: unknown) =>
    Api.pipe(Effect.flatMap((api) => api.request(actor, method, `${prefix}${path}`, data)));
  return {
    deploy: (name, files) =>
      request("POST", "/apps/deploy", { name, files }).pipe(Effect.flatMap(ok(App))),
    redeploy: (app, files) =>
      request("POST", `/apps/${app.id}/deploy`, { files }).pipe(
        Effect.flatMap(ok(Deployed)),
        Effect.asVoid,
      ),
    build: (app) =>
      request("GET", `/apps/${app.id}/source`).pipe(
        Effect.flatMap(ok(Source)),
        Effect.map((source) => source.build),
      ),
    call: (app, tool) =>
      request("POST", `/apps/${app.id}/tools/call`, { tool, input: {} }).pipe(
        Effect.flatMap(ok(Schema.String)),
      ),
    cleanup: (app) => request("DELETE", `/apps/${app.id}`),
  };
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
  return {
    deploy: (name, files) =>
      request("POST", "/v1/apps/deploy", { owner, name, files }).pipe(
        Effect.flatMap(ok(Deployed)),
        Effect.map((deployed) => deployed.app),
      ),
    redeploy: (app, files) =>
      request("POST", "/v1/apps/deploy", { owner, app: app.id, files }).pipe(
        Effect.flatMap(ok(Deployed)),
        Effect.asVoid,
      ),
    build: (app) =>
      request("GET", `/v1/apps/${app.id}/source?owner=${owner}`).pipe(
        Effect.flatMap(ok(Source)),
        Effect.map((source) => source.build),
      ),
    call: (app, tool) =>
      request("POST", "/v1/tools/call", { app: app.id, tool, input: {} }).pipe(
        Effect.flatMap(
          ok(Schema.Struct({ status: Schema.Literal("completed"), value: Schema.String })),
        ),
        Effect.map((result) => result.value),
      ),
    cleanup: (app) => request("DELETE", `/v1/apps/${app.id}?owner=${owner}`),
  };
};

/** The SHA-256 a framework is stored under: its server modules, sorted by name. */
const frameworkHash = (modules: Readonly<Record<string, string>>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(modules)
          .sort()
          .map((name) => [name, modules[name]]),
      ),
    )
    .digest("hex");

const migrate = (surface: Surface) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const log = `${target.directory}/server.log`;
    const directory = path.join(target.directory, "data", "builds");
    const created: App[] = [];
    yield* Effect.addFinalizer(() => Effect.forEach(created, surface.cleanup).pipe(Effect.ignore));
    const deploy = (name: string, files: Files) =>
      surface
        .deploy(`${name} ${randomUUID().slice(0, 8)}`, files)
        .pipe(Effect.tap((app) => Effect.sync(() => created.push(app))));
    const summaries = dataStepSummaries(log, step).pipe(Effect.map((all) => all.length));
    /** Start the stopped product in `mode` and return the summary it logged for the step. */
    const startIn = (mode: "report" | "apply") =>
      Effect.gen(function* () {
        yield* serverControl("data-steps", 200, { mode });
        const seen = yield* summaries;
        yield* serverControl("start");
        return yield* nextDataStepSummary(log, step, seen);
      });

    // The product started with the steps held, so the step reported before these apps existed.
    expect(yield* nextDataStepSummary(log, step, 0)).toMatchObject({
      mode: "report",
      status: "complete",
    });

    const active = yield* deploy("Inlined active", current("active"));
    const replaced = yield* deploy("Inlined replaced", current("replaced first"));
    const replacedFirst = yield* surface.build(replaced);
    yield* surface.redeploy(replaced, current("replaced second"));
    const old = yield* deploy("Inlined older release", older("older"));
    const corrupt = yield* deploy("Inlined corrupt", current("corrupt"));
    const builds = {
      active: yield* surface.build(active),
      replacedFirst,
      replacedSecond: yield* surface.build(replaced),
      old: yield* surface.build(old),
      corrupt: yield* surface.build(corrupt),
    };
    const readable = [builds.active, builds.replacedFirst, builds.replacedSecond, builds.old];
    expect(new Set([...readable, builds.corrupt]).size, "Every deploy retained its own build").toBe(
      5,
    );
    const recordFile = (build: string) => path.join(directory, build, "worker.json");
    const inlinedFile = (build: string) => path.join(directory, `${build}.json`);
    const frameworkFile = (identity: Identity) =>
      path.join(directory, "frameworks", `${identity.version}-${identity.sha256}.json`);
    const record = (build: string) =>
      fs
        .readFileString(recordFile(build))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SplitRecord)));
    const olderFramework = (yield* record(builds.old)).framework;
    expect(olderFramework.version).toBe(olderRelease);

    // Rewrite the builds as hosts stored them before the split: the framework's modules inlined
    // beside the app's, with no format or framework fields, and no record.
    yield* serverControl("stop");
    for (const build of readable) {
      const stored = yield* fs
        .readFileString(recordFile(build))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)));
      const identity = yield* Schema.decodeUnknownEffect(Identity)(stored.framework);
      const framework = yield* fs
        .readFileString(frameworkFile(identity))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(JsonObject)));
      const { format: _format, framework: _framework, ...rest } = stored;
      const inlined = {
        ...rest,
        modules: {
          ...(yield* Schema.decodeUnknownEffect(Modules)(stored.modules)),
          ...(yield* Schema.decodeUnknownEffect(Modules)(framework.modules)),
        },
      };
      yield* fs.writeFileString(inlinedFile(build), JSON.stringify(inlined));
      yield* fs.remove(recordFile(build));
    }
    // Only the older app links this release, so the step must store its framework again.
    yield* fs.remove(frameworkFile(olderFramework));
    yield* fs.writeFileString(inlinedFile(builds.corrupt), "{ not a build");
    yield* fs.remove(recordFile(builds.corrupt));
    const inlinedBefore = yield* Effect.forEach([...readable, builds.corrupt], (build) =>
      fs.readFileString(inlinedFile(build)),
    );
    /** Every `<build>.json` is kept byte for byte; the step never rewrites or deletes one. */
    const inlinedKept = Effect.gen(function* () {
      const now = yield* Effect.forEach([...readable, builds.corrupt], (build) =>
        fs.readFileString(inlinedFile(build)),
      );
      expect(now).toEqual(inlinedBefore);
    });
    /** Other builds on the host were stored split already; the scenario's own five were not. */
    const unexpected = (outcomes: Readonly<Record<string, number>>) =>
      Object.keys(outcomes).filter(
        (outcome) => !["split", "invalid", "already-split"].includes(outcome),
      );

    // Report: every readable build would split, the corrupt one is invalid, and nothing is written.
    const report = yield* startIn("report");
    expect(report).toMatchObject({ mode: "report", status: "complete" });
    expect(report.outcomes.split).toBe(readable.length);
    expect(report.outcomes.invalid).toBe(1);
    expect(unexpected(report.outcomes)).toEqual([]);
    for (const build of [...readable, builds.corrupt])
      expect(yield* fs.exists(recordFile(build)), build).toBe(false);
    expect(yield* fs.exists(frameworkFile(olderFramework))).toBe(false);
    yield* inlinedKept;

    // Apply: the same outcomes, now written. The corrupt build is not retried.
    yield* serverControl("stop");
    const applied = yield* startIn("apply");
    expect(applied).toMatchObject({ mode: "apply", run: "apply", status: "complete", pass: 1 });
    expect(applied.outcomes.split).toBe(readable.length);
    expect(applied.outcomes.invalid).toBe(1);
    expect(unexpected(applied.outcomes)).toEqual([]);
    for (const build of readable) {
      const split = yield* record(build);
      expect(
        Object.keys(split.modules).filter((name) => name.startsWith("node_modules/apps/")),
        "The record holds none of the framework's modules",
      ).toEqual([]);
      const framework = yield* fs
        .readFileString(frameworkFile(split.framework))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredFramework)));
      expect(framework.sha256).toBe(split.framework.sha256);
      expect(frameworkHash(framework.modules), "The stored framework matches its hash").toBe(
        split.framework.sha256,
      );
    }
    // Labels come from the published release table, the same names new deploys store.
    expect((yield* record(builds.active)).framework.version).toBe(appsVersion);
    expect((yield* record(builds.old)).framework).toEqual(olderFramework);
    expect(yield* fs.exists(recordFile(builds.corrupt))).toBe(false);
    yield* inlinedKept;

    // The apps keep working from their split builds after a cold start.
    expect(yield* surface.call(active, "ping")).toBe("active");
    expect(yield* surface.call(replaced, "ping")).toBe("replaced second");
    expect(yield* surface.call(old, "queries.ping")).toBe("older");

    // A later report checks the applied result: every readable build is already split.
    yield* serverControl("stop");
    const rerun = yield* startIn("report");
    expect(rerun).toMatchObject({ mode: "report", status: "complete" });
    expect(rerun.outcomes.split).toBeUndefined();
    expect(rerun.outcomes.invalid).toBe(1);
    expect(rerun.outcomes["already-split"]).toBeGreaterThanOrEqual(readable.length);
    expect(Object.keys(rerun.outcomes).toSorted()).toEqual(["already-split", "invalid"]);
    yield* inlinedKept;
  });

layer(HostedLive, { excludeTestServices: true })("Build framework migration", (it) => {
  it.effect(
    scenarios.buildFrameworkMigration.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors;
          return yield* migrate(hostedSurface(actors.owner, actors.organization.id));
        }),
      ),
    // The product starts four times: held, a report, the apply and a checking report.
    { timeout: 180_000 },
  );
  it.effect(
    scenarios.localBuildFrameworkMigration.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api;
          const target = yield* Target;
          return yield* migrate(localSurface(yield* api.session(), Redacted.value(target.apiKey)));
        }),
      ),
    { timeout: 180_000 },
  );
});
