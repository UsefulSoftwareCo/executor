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

// An absolute sleep deadline can pass while the process is down. The resumed run must treat
// that sleep as finished rather than as a deadline in the past.
it.live(
  "released image finishes a workflow run whose sleep deadline passed while it was stopped",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({ accounts: {} }, {
  workflows: {
    deadline: workflow({ input: object({}) }, async (ctx) => {
      const before = await ctx.step.do("before", async () => Date.now() + 30_000);
      await ctx.step.sleepUntil("wake", before);
      const after = await ctx.step.do("after", async () => Date.now());
      return { before, after };
    }),
  },
});`);
        const started = yield* server.json(WorkflowRun, server.runs, {
          workflow: "deadline",
          input: {},
          key: randomUUID(),
        });
        yield* Effect.sleep("10 seconds");
        yield* server.restartAfter("40 seconds");
        const finished = yield* finishedRun(server, started.id);
        expect(finished, "the run completes").toMatchObject({ status: "complete" });
        const output = yield* Schema.decodeUnknownEffect(Timed)(finished.output);
        expect(output.after).toBeGreaterThanOrEqual(output.before);
        expect(yield* unloadedEngines(server), "the finished run's engine leaves memory").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  480_000,
);

// A terminated run's engine must neither resume after a restart nor stay loaded.
it.live(
  "released image keeps a terminated sleeping workflow run stopped across a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* workflowServer(`import { defineApp, workflow, object } from "apps";
export default defineApp({ accounts: {} }, {
  workflows: {
    halted: workflow({ input: object({}) }, async (ctx) => {
      await ctx.step.do("before", async () => Date.now());
      await ctx.step.sleep("nap", "45 seconds");
      return await ctx.step.do("after", async () => Date.now());
    }),
  },
});`);
        const started = yield* server.json(WorkflowRun, server.runs, {
          workflow: "halted",
          input: {},
          key: randomUUID(),
        });
        yield* Effect.sleep("10 seconds");
        const terminated = yield* server.json(
          WorkflowRun,
          `${server.runs}/${started.id}/terminate`,
          {},
        );
        expect(terminated.status).toBe("terminated");
        yield* server.restart;
        // Past the sleep's deadline, when a resumed run would have completed.
        yield* Effect.sleep("60 seconds");
        expect((yield* server.json(WorkflowRun, `${server.runs}/${started.id}`)).status).toBe(
          "terminated",
        );
        expect(yield* unloadedEngines(server), "the terminated run's engine is not loaded").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  480_000,
);
