import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { workflowServer, WorkflowRun } from "../support/docker-workflows.ts";

it.live(
  "released image releases finished workflow runs from memory",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({}, {
  workflows: { once: workflow({ input: object({}) }, async (ctx) => ctx.step.do("once", async () => ctx.runId)) },
});`);
        const runs = yield* Effect.forEach(
          Array.from({ length: 8 }, () => randomUUID()),
          (key) => server.json(WorkflowRun, server.runs, { workflow: "once", input: {}, key }),
        );
        for (const started of runs)
          expect(
            (yield* server.json(WorkflowRun, `${server.runs}/${started.id}`).pipe(
              Effect.flatMap((current) =>
                current.status === "complete" ? Effect.succeed(current) : Effect.fail(current),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
            )).status,
          ).toBe("complete");
        expect(
          yield* server.loadedEngines,
          "engines are loaded while their runs are recent",
        ).toBeGreaterThan(0);
        const settled = yield* server.loadedEngines.pipe(
          Effect.flatMap((loaded) => (loaded === 0 ? Effect.succeed(loaded) : Effect.fail(loaded))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
          // Report how many engines remain loaded rather than that polling ran out.
          Effect.catch((error) =>
            typeof error === "number" ? Effect.succeed(error) : Effect.fail(error),
          ),
        );
        expect(settled, "finished runs' engines leave memory once idle").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  360_000,
);
