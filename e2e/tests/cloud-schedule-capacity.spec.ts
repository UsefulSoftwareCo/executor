import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const slowCount = 9;
const slowMs = 15_000;

const slowNames = Array.from({ length: slowCount }, (_, index) => `slow${index + 1}`);
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
          for (const name of names)
            expect(
              (yield* api.request(actors.owner, "POST", `${path}/schedules/${name}/run`)).status,
            ).toBe(200);

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
          expect(Math.max(...slow.map((run) => at(run.startedAt)))).toBeLessThan(firstSlowEnd);
          expect(at(quick.finishedAt!)).toBeLessThan(firstSlowEnd);
        }),
      ),
    { timeout: 120_000 },
  );
});
