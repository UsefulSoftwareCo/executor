import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import {
  workflowServer,
  WorkflowRun,
  finishedRun,
  unloadedEngines,
  Timed,
} from "../support/docker-workflows.ts";

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
export default defineApp({ accounts: {} }, {
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

// Runs sleep side by side, each in its own engine. A restart part way through their sleeps must
// resume every one of them from its alarm, without repeating the step each finished before.
it.live(
  "released image resumes concurrent sleeping workflow runs after a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const count = 12;
        const sleepSeconds = 60;
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({ accounts: {} }, {
  workflows: {
    nap: workflow({ input: object({}) }, async (ctx) => {
      const before = await ctx.step.do("before", async () => Date.now());
      await ctx.step.sleep("nap", "${sleepSeconds} seconds");
      const after = await ctx.step.do("after", async () => Date.now());
      return { before, after };
    }),
  },
});`);
        const created = Date.now();
        const runs = yield* Effect.forEach(
          Array.from({ length: count }, () => randomUUID()),
          (key) => server.json(WorkflowRun, server.runs, { workflow: "nap", input: {}, key }),
          { concurrency: "unbounded" },
        );
        yield* Effect.sleep("20 seconds");
        for (const started of runs)
          expect(
            (yield* server.json(WorkflowRun, `${server.runs}/${started.id}`)).status,
            "every run is sleeping",
          ).toBe("running");
        expect(yield* server.loadedEngines, "each sleeping run holds its engine").toBe(count);
        const restarted = Date.now();
        yield* server.restart;
        const finished = yield* Effect.forEach(runs, (started) => finishedRun(server, started.id), {
          concurrency: "unbounded",
        });
        for (const run of finished) {
          expect(run, "every run completes").toMatchObject({ status: "complete" });
          const output = yield* Schema.decodeUnknownEffect(Timed)(run.output);
          // The first step ran once, before the restart; a repeated step would record a later time.
          expect(output.before).toBeGreaterThanOrEqual(created);
          expect(output.before).toBeLessThan(restarted);
          expect(output.after - output.before).toBeGreaterThanOrEqual(sleepSeconds * 1000);
        }
        expect(yield* unloadedEngines(server), "finished runs' engines leave memory").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  720_000,
);
