/**
 * A scheduled run executes the app's active build. The runner reads builds by the ID each run
 * names, so a run after a redeploy must execute the new code, never a build an earlier run loaded.
 * Each build load a run causes carries the run's ID: one scheduler dispatch runs every due
 * schedule in one trace, so the trace alone cannot tell which run a load belongs to.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { buildLoadSpan } from "../support/build-loads.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Runs = Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String }));
const Source = Schema.Struct({ build: Schema.String });
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}

/** Each scheduled run records which build ran it. The daily interval never fires during the case. */
const files = (label: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, query, mutation, interval, object, router } from "apps";
const record = mutation({ input: object({}) }, async (ctx) => {
  ctx.sql.exec("INSERT INTO runs (label, created_at) VALUES (?, ?)", ${JSON.stringify(label)}, Date.now());
  return { label: ${JSON.stringify(label)} };
});
const labels = query({ input: object({}) }, async (ctx) =>
  ctx.sql.exec("SELECT label FROM runs ORDER BY rowid").toArray().map((run) => run.label));
export default defineApp({ accounts: {} }, async () => ({
  tools: router({ record, labels }),
  schedules: { record: interval({ hours: 24 }, record, {}) },
}));`,
  },
  {
    path: "migrations/0001_runs.sql",
    content: "CREATE TABLE runs (label TEXT NOT NULL, created_at INTEGER NOT NULL);\n",
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Scheduled runs after a redeploy", (it) => {
  it.effect(scenarios.scheduledRunRedeploy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Scheduled redeploy ${randomUUID().slice(0, 8)}`,
          files: files("first build"),
        });
        expect(created.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), created);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const build = api
          .request(actors.owner, "GET", `${path}/source`)
          .pipe(Effect.flatMap((response) => body(Source, response)));
        const labels = api
          .request(actors.owner, "POST", `${path}/data/query`, { name: "labels", input: {} })
          .pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.map((response) => response.body),
          );
        const succeeded = (count: number) =>
          api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`).pipe(
            Effect.flatMap((response) => body(Runs, response)),
            Effect.flatMap((runs) =>
              runs.filter((run) => run.status === "succeeded").length >= count
                ? Effect.succeed(runs)
                : Effect.fail(new Pending()),
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("200 millis"),
            }),
            Effect.timeout("30 seconds"),
          );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/schedules/record`, {
            enabled: true,
            approvalMode: "automatic",
          })).status,
        ).toBe(200);

        expect(
          (yield* api.request(actors.owner, "POST", `${path}/schedules/record/run`)).status,
        ).toBe(200);
        const [firstRun] = (yield* succeeded(1)).filter((run) => run.status === "succeeded");
        expect(yield* labels).toEqual(["first build"]);
        const firstBuild = yield* build;

        // The redeploy activates a new immutable build; the next run must load it, not reuse the
        // first build's code that the runner already read.
        const redeployed = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: files("second build"),
        });
        expect(redeployed.status).toBe(200);
        const secondBuild = yield* build;
        expect(secondBuild.build, "The redeploy activated a new build").not.toBe(firstBuild.build);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/schedules/record/run`)).status,
        ).toBe(200);
        const runs = yield* succeeded(2);
        expect(runs.filter((run) => run.status !== "succeeded")).toEqual([]);
        expect(yield* labels, "The run after the redeploy executed the new build").toEqual([
          "first build",
          "second build",
        ]);

        const telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const secondRun = runs.find((run) => run.id !== firstRun?.id);
        const loads = (run: string | undefined) =>
          telemetry.spans(buildLoadSpan, {
            "executor.app.id": app.id,
            "executor.run.id": run ?? "",
          });
        // The deploy migrates the app's database through the new build, so that build is loaded
        // before the second run, which may then find it warm. The new build was loaded, and every
        // load the second run caused read it.
        const newBuildLoads = yield* telemetry
          .spans(buildLoadSpan, {
            "executor.app.id": app.id,
            "executor.build.id": secondBuild.build,
          })
          .pipe(
            Effect.flatMap((tags) =>
              tags.length > 0 ? Effect.succeed(tags) : Effect.fail(new Pending()),
            ),
            Effect.retry({
              schedule: Schedule.spaced("500 millis"),
              times: 60,
              while: (error) => error instanceof Pending,
            }),
          );
        expect(newBuildLoads.length).toBeGreaterThan(0);
        const second = yield* loads(secondRun?.id);
        const first = yield* loads(firstRun?.id);
        yield* evidence.json("scheduled-run-build-loads.json", { first, second });
        expect(
          second.map((tags) => tags["executor.build.id"]),
          "Every load tagged with the second run read the second build",
        ).toEqual(second.map(() => secondBuild.build));
        expect(
          first.map((tags) => tags["executor.build.id"]),
          "Every load tagged with the first run read the first build",
        ).toEqual(first.map(() => firstBuild.build));
      }),
    ),
  );
});
