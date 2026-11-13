import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { workflowServer, WorkflowRun } from "../support/docker-workflows.ts";

// A run woken by its alarm has no caller holding its engine, unlike a run just created. A long
// step that starts in an engine loaded by the alarm must still run once and finish in time. The
// host's reconciliation also reads running runs every few seconds; workflow-engine.spec.ts
// checks the engine alone, with nothing reading its runs.
it.live(
  "released image finishes a long workflow step that starts after a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stepSeconds = 180;
        const sleepSeconds = 45;
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({}, {
  workflows: {
    woken: workflow({ input: object({}) }, async (ctx) => {
      await ctx.step.sleep("wait", "${sleepSeconds} seconds");
      const long = await ctx.step.do("long", { timeout: "10 minutes" }, async () => {
        const started = Date.now();
        await new Promise((resolve) => setTimeout(resolve, ${stepSeconds * 1000}));
        return started;
      });
      const after = await ctx.step.do("after", async () => Date.now());
      return { long, after };
    }),
  },
});`);
        const started = yield* server.json(WorkflowRun, server.runs, {
          workflow: "woken",
          input: {},
          key: randomUUID(),
        });
        const created = Date.now();
        yield* Effect.sleep("10 seconds");
        // The process stops during the sleep, so only the durable alarm can start the long step.
        yield* server.restart;
        // The test does not read the run while its long step runs.
        yield* Effect.sleep(`${sleepSeconds + stepSeconds} seconds`);
        const finished = yield* server.json(WorkflowRun, `${server.runs}/${started.id}`).pipe(
          Effect.flatMap((run) =>
            ["complete", "errored", "terminated"].includes(run.status)
              ? Effect.succeed(run)
              : Effect.fail(run),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
          Effect.catch((run) => ("status" in run ? Effect.succeed(run) : Effect.fail(run))),
        );
        expect(finished, "the run completes about when its step ends").toMatchObject({
          status: "complete",
        });
        const output = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ long: Schema.Number, after: Schema.Number }),
        )(finished.output);
        // The step started once, when the alarm ended the sleep. A step restarted after its
        // engine was unloaded would record a start near its ten minute deadline.
        expect(output.long - created).toBeLessThan((sleepSeconds + 30) * 1000);
        expect(output.after - output.long).toBeGreaterThanOrEqual(stepSeconds * 1000);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  600_000,
);
