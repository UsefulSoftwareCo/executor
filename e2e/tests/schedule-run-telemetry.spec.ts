/**
 * A scheduled run's error cannot say who failed it: a mutation that throws and one whose reply
 * Executor's runtime lost both fail with `ToolCallFailed`. Its span records what the call failed
 * with. On Cloud, the coordinator's pass records how many schedules were due before it claimed
 * any, and how long the oldest had waited.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

/**
 * `crash` throws. `lost` returns, but the app's isolate fails the runtime's read of its reply, so
 * no usable answer reaches Executor. Hourly schedules never fall due during the scenario; Run Now
 * makes each one due.
 */
const source = `import { defineApp, mutation, userInterval, object, string, router } from "apps";
const json = Response.prototype.json;
Response.prototype.json = async function () {
  const value = await json.call(this);
  if (JSON.stringify(value).includes("reply-" + "lost")) throw new Error("Synthetic lost reply");
  return value;
};
const fine = mutation({ input: object({}) }, async () => ({ done: true }));
const crash = mutation({ input: object({}) }, async () => { throw new Error("Synthetic app failure"); });
const lost = mutation({ input: object({}), output: string() }, async () => "reply-" + "lost");
export default defineApp({}, async () => ({ tools: router({ fine, crash, lost }), schedules: {
  fine: userInterval({ minutes: 60 }, fine, {}),
  crash: userInterval({ minutes: 60 }, crash, {}),
  lost: userInterval({ minutes: 60 }, lost, {}),
} }));`;
const names = ["fine", "crash", "lost"] as const;

const Runs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    finishedAt: Schema.NullOr(Schema.String),
    failure: Schema.NullOr(Schema.String),
  }),
);
class Pending extends Schema.TaggedError<Pending>()("Pending", { found: Schema.Number }) {}

layer(HostedLive, { excludeTestServices: true })("Schedule run telemetry", (it) => {
  it.effect(scenarios.scheduleRunTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Run sources ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        for (const name of names) {
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/schedules/${name}`, {
              enabled: true,
              approvalMode: "automatic",
            })).status,
          ).toBe(200);
          expect(
            (yield* api.request(actors.owner, "POST", `${path}/schedules/${name}/run`)).status,
          ).toBe(200);
        }

        const runs = yield* api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(
            Effect.flatMap((response) => body(Runs, response)),
            Effect.flatMap((runs) => {
              const found = runs.filter((run) => run.finishedAt !== null).length;
              return found === names.length
                ? Effect.succeed(runs)
                : Effect.fail(new Pending({ found }));
            }),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("250 millis"),
              times: 120,
            }),
          );
        yield* evidence.json("scheduled-runs.json", runs);
        const run = (name: (typeof names)[number]) => {
          const found = runs.find((run) => run.name === name);
          if (found === undefined) throw new Error(`No ${name} run`);
          return found;
        };
        // The run's own error is the same for the app's failure and the runtime's.
        expect(names.map((name) => [run(name).status, run(name).failure])).toEqual([
          ["succeeded", null],
          ["failed", "ToolCallFailed"],
          ["failed", "ToolCallFailed"],
        ]);

        const spans = yield* telemetry.search("schedule.run", { "executor.app.id": app.id }).pipe(
          Effect.map((found) =>
            found.data.filter(({ span }) => span.operationName === "schedule.run"),
          ),
          Effect.flatMap((found) =>
            names.every((name) =>
              found.some(({ span }) => span.tags["executor.run.id"] === run(name).id),
            )
              ? Effect.succeed(found)
              : Effect.fail(new Pending({ found: found.length })),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        yield* evidence.json(
          "schedule-run-spans.json",
          spans.map(({ traceId, span }) => ({ traceId, status: span.status, tags: span.tags })),
        );
        const spanOf = (name: (typeof names)[number]) => {
          const found = spans.find(({ span }) => span.tags["executor.run.id"] === run(name).id);
          if (found === undefined) throw new Error(`No span of the ${name} run`);
          return found;
        };
        // Its span says what each call failed with, and a run that succeeded records no source.
        expect(spanOf("fine").span.tags).toMatchObject({ "executor.outcome": "completed" });
        expect(spanOf("fine").span.tags).not.toHaveProperty("executor.failure.source");
        expect(spanOf("crash").span.tags).toMatchObject({
          "executor.outcome": "failed",
          "error.type": "ToolCallFailed",
          "executor.failure.source": "app",
        });
        expect(spanOf("lost").span.tags).toMatchObject({
          "executor.outcome": "failed",
          "error.type": "ToolCallFailed",
          "executor.failure.source": "runtime",
        });

        if (target.metadata.target === "cloud") {
          // Each run's trace holds the coordinator's pass that claimed it. That pass found the run
          // due, at least, and the oldest due schedule it found waited at least as long as the run.
          for (const name of names) {
            const { traceId, span } = spanOf(name);
            const pass = yield* telemetry.query(traceId).pipe(
              Effect.map((trace) =>
                trace.data.find(
                  ({ span }) =>
                    span.operationName === "schedule.dispatch" &&
                    span.tags["executor.schedule.runner"] === "cloud",
                ),
              ),
              Effect.flatMap((found) =>
                found === undefined
                  ? Effect.fail(new Pending({ found: 0 }))
                  : Effect.succeed(found.span.tags),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
            );
            yield* evidence.json(`${name}-dispatch.json`, pass);
            expect(Number(pass["executor.schedule.due"])).toBeGreaterThanOrEqual(1);
            expect(Number(pass["executor.schedule.oldest_due_ms"])).toBeGreaterThanOrEqual(
              Number(span.tags["executor.schedule.lateness_ms"]),
            );
          }
        }
      }),
    ),
  );
});
