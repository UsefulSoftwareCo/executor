import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { workflowServer, WorkflowRun } from "../support/docker-workflows.ts";

it.live(
  "released image finishes workflow runs whose steps outlast the idle window and whose engines stop while they sleep",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stepSeconds = 180;
        const sleepSeconds = 120;
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({}, {
  workflows: {
    patient: workflow({ input: object({}) }, async (ctx) => {
      const long = await ctx.step.do("long", { timeout: "10 minutes" }, async () => {
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, ${stepSeconds * 1000}));
        return started;
      });
      await ctx.step.sleep("rest", "${sleepSeconds} seconds");
      const resumed = await ctx.step.do("after", async () => Date.now());
      return { long, resumed };
    }),
  },
});`);
        const created = Date.now();
        const started = yield* server.json(WorkflowRun, server.runs, {
          workflow: "patient",
          input: {},
          key: randomUUID(),
        });
        const current = server.json(WorkflowRun, `${server.runs}/${started.id}`);
        yield* Effect.sleep(`${stepSeconds - 20} seconds`);
        expect((yield* current).status, "the long step is still running").toBe("running");
        expect(yield* server.loadedEngines, "a running step holds its engine").toBe(1);
        yield* Effect.sleep(`${20 + sleepSeconds / 4} seconds`);
        expect((yield* current).status, "the run is sleeping").not.toBe("complete");
        yield* server.restart;
        const finished = yield* current.pipe(
          Effect.flatMap((run) =>
            ["complete", "errored", "terminated"].includes(run.status)
              ? Effect.succeed(run)
              : Effect.fail(run),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 150 }),
        );
        expect(finished, "the run completes").toMatchObject({ status: "complete" });
        const output = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ long: Schema.Number, resumed: Schema.Number }),
        )(finished.output);
        expect(output.long - created).toBeLessThan(30_000);
        expect(output.resumed - output.long).toBeGreaterThanOrEqual(
          (stepSeconds + sleepSeconds) * 1000,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  720_000,
);
