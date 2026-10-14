/**
 * Local and desktop run each workflow run as its own engine in the product's workerd process.
 * An engine that stays loaded after its run finishes keeps its database and state resident, so
 * a long-running local or desktop process grows with every run it has ever executed.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startLocalProduct, workflowEngines } from "../support/local-workflow-engines.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Run = Schema.Struct({ id: Schema.String, status: Schema.String });

layer(TestLive, { excludeTestServices: true })("Local workflow engine memory", (it) => {
  it.effect(
    scenarios.localWorkflowEngineMemory.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const local = yield* startLocalProduct();
          const { app } = yield* local.json(App, "POST", "/v1/apps/deploy", {
            owner: "workflow-engines-e2e",
            name: `Workflow engines ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, workflow, object } from "apps";
export default defineApp({}, {
  workflows: { once: workflow({ input: object({}) }, async (ctx) => ctx.step.do("once", async () => ctx.runId)) },
});`,
              },
              appsManifest,
            ],
          });
          const runs = yield* Effect.forEach(Array.from({ length: 8 }, randomUUID), (key) =>
            local.json(Run, "POST", `/v1/apps/${app.id}/workflow-runs`, {
              workflow: "once",
              input: {},
              key,
            }),
          );
          for (const started of runs)
            expect(
              (yield* local.json(Run, "GET", `/v1/apps/${app.id}/workflow-runs/${started.id}`).pipe(
                Effect.flatMap((current) =>
                  current.status === "complete" ? Effect.succeed(current) : Effect.fail(current),
                ),
                Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
              )).status,
            ).toBe("complete");
          const loaded = workflowEngines(local.directory).pipe(
            Effect.map((engines) => engines.loaded),
          );
          expect(yield* loaded, "engines are loaded while their runs are recent").toBeGreaterThan(
            0,
          );
          // workerd unloads an idle object once it has been inactive for about 70 s and its
          // callers have gone, checked on a timer, so within about two and a half minutes.
          const settled = yield* loaded.pipe(
            Effect.flatMap((count) => (count === 0 ? Effect.succeed(count) : Effect.fail(count))),
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
            // Report how many engines remain loaded rather than that polling ran out.
            Effect.catch((error) =>
              typeof error === "number" ? Effect.succeed(error) : Effect.fail(error),
            ),
          );
          expect(settled, "finished runs' engines leave memory once idle").toBe(0);
        }),
      ),
    360_000,
  );
});
