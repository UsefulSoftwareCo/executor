/**
 * Cloud's one schedule coordinator runs every organization's scheduled runs. A run holds its slot
 * while its mutation waits on the services it calls, so slow runs must not keep other due runs
 * from starting. With the Node hosts' 8 slots, nine slow runs left one of them, and every later
 * due run, waiting until a slow run finished.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

/** More slow runs than the 8 slots Cloud used to share between organizations. */
const slowCount = 9;
/** How long each slow run waits, standing in for a slow service. */
const slowMs = 15_000;

const slowNames = Array.from({ length: slowCount }, (_, index) => `slow${index + 1}`);
/** Hourly schedules never fall due during the scenario; Run Now makes each one due. */
const source = `import { defineApp, mutation, userInterval, object, router } from "apps";
const slow = mutation({ input: object({}) }, async () => {
  await new Promise((resolve) => setTimeout(resolve, ${slowMs}));
  return { done: true };
});
const quick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({}, async () => ({ tools: router({ slow, quick }), schedules: {
${slowNames.map((name) => `  ${name}: userInterval({ minutes: 60 }, slow, {}),`).join("\n")}
  quick: userInterval({ minutes: 60 }, quick, {}),
} }));`;

const Runs = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    startedAt: Schema.String,
    finishedAt: Schema.NullOr(Schema.String),
  }),
);
class Pending extends Schema.TaggedError<Pending>()("Pending", { finished: Schema.Number }) {}

layer(HostedLive, { excludeTestServices: true })("Cloud schedule capacity", (it) => {
  it.effect(
    scenarios.cloudScheduleCapacity.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Capacity ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );
          const names = [...slowNames, "quick"];
          for (const name of names)
            expect(
              (yield* api.request(actors.owner, "PATCH", `${path}/schedules/${name}`, {
                enabled: true,
                approvalMode: "automatic",
              })).status,
            ).toBe(200);
          // Every slow run is due before the quick one, so a full pool admits the slow runs first.
          for (const name of names)
            expect(
              (yield* api.request(actors.owner, "POST", `${path}/schedules/${name}/run`)).status,
            ).toBe(200);

          // Each slow run finishes about 15 s after it starts. Waiting for all of them bounds the
          // poll by the slow runs' own duration, not by a guess at the coordinator's speed.
          const runs = yield* api
            .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
            .pipe(
              Effect.flatMap((response) => body(Runs, response)),
              Effect.flatMap((runs) => {
                const finished = runs.filter((run) => run.finishedAt !== null).length;
                return finished === names.length
                  ? Effect.succeed(runs)
                  : Effect.fail(new Pending({ finished }));
              }),
              Effect.retry({
                while: (error) => error instanceof Pending,
                schedule: Schedule.spaced("500 millis"),
                times: 120,
              }),
            );
          expect(runs.map((run) => run.status)).toEqual(names.map(() => "succeeded"));
          const at = (time: string) => Date.parse(time);
          const slow = runs.filter((run) => run.name !== "quick");
          const quick = runs.find((run) => run.name === "quick")!;
          const firstSlowEnd = Math.min(...slow.map((run) => at(run.finishedAt!)));
          // All nine slow runs were in flight together, and the quick run started and finished
          // while they were: none of them waited for a slow run to free its slot.
          expect(Math.max(...slow.map((run) => at(run.startedAt)))).toBeLessThan(firstSlowEnd);
          expect(at(quick.finishedAt!)).toBeLessThan(firstSlowEnd);
        }),
      ),
    { timeout: 120_000 },
  );
});
