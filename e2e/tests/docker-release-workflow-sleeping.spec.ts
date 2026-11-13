import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import {
  workflowServer,
  WorkflowRun,
  finishedRun,
  unloadedEngines,
  Timed,
} from "../support/docker-workflows.ts";

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
export default defineApp({}, {
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
