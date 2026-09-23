/** Real product checks with durable markers for timeout writes and observable sleep windows. */
import { expect, layer } from "@effect/vitest";
import { Clock, Config, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { durabilityFiles } from "../support/workflow-durability.ts";
import { WorkflowApp, WorkflowRun } from "../support/workflow-app.ts";

const Rows = Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }));
const Page = Schema.Struct({ items: Schema.Array(WorkflowRun) });
const Marker = Schema.Struct({ key: Schema.String, row: Schema.String });
const fixture = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const root = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${root}/deploy`, {
    name: `Durability ${randomUUID()}`,
    files: durabilityFiles,
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(WorkflowApp, deployed);
  const path = `${root}/${app.id}`;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "GET", `${path}/workflow-runs`);
      expect(response.status).toBe(200);
      // Include the marker runs started inside mutations, even if an assertion failed early.
      for (const run of (yield* body(Page, response)).items)
        yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run.id}/terminate`);
      expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
    }).pipe(Effect.orDie),
  );
  const get = (id: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${id}`);
      expect(response.status).toBe(200);
      return yield* body(WorkflowRun, response);
    });
  const wait = (id: string, status: string, milliseconds = 40000) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + milliseconds;
      while (true) {
        const run = yield* get(id);
        if (run.status === status) return run;
        expect(
          ["complete", "errored", "terminated"].includes(run.status),
          JSON.stringify(run),
        ).toBe(false);
        expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
        yield* Effect.sleep("500 millis");
      }
    });
  return {
    app,
    wait,
    start: (workflow: string, input: Schema.Json) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow,
          input,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* body(WorkflowRun, response);
      }),
    rows: () =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "queries.rows",
          input: {},
        });
        expect(response.status).toBe(200);
        return yield* body(Rows, response);
      }),
    marker: (key: string) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + 20000;
        while (true) {
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${path}/workflow-runs?workflow=inserted`,
          );
          expect(response.status).toBe(200);
          for (const run of (yield* body(Page, response)).items) {
            if (run.status !== "complete") continue;
            const marker = yield* Schema.decodeUnknownEffect(Marker)(run.output);
            if (marker.key === key) return { run: run.id, ...marker };
          }
          expect(
            yield* Clock.currentTimeMillis,
            "No durable marker confirmed the insert",
          ).toBeLessThan(deadline);
          yield* Effect.sleep("250 millis");
        }
      }),
  };
});

layer(HostedLive, { excludeTestServices: true })("Workflow durability", (it) => {
  it.effect(scenarios.workflowTimeout.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* fixture;
        const evidence = yield* Evidence;
        const committed = yield* app.start("write", { key: "committed", wait: 0 });
        const saved = yield* app.wait(committed.id, "complete");
        const control = yield* app.marker("committed");
        expect(saved.output).toBe(control.row);
        expect(yield* app.rows()).toEqual([{ id: control.row, label: "committed" }]);

        const timed = yield* app.start("write", { key: "rolled-back", wait: 10000 });
        const marker = yield* evidence.step(
          "Confirm inserted row through a separate durable run",
          app.marker("rolled-back"),
        );
        const observed = yield* Clock.currentTimeMillis;
        const failed = yield* app.wait(timed.id, "errored");
        expect(failed.error).toBe("engine");
        expect(yield* app.rows()).toEqual([{ id: control.row, label: "committed" }]);
        // Let the authored body reach its natural return time if cancellation fails to stop it.
        const remaining = observed + 11000 - (yield* Clock.currentTimeMillis);
        if (remaining > 0) yield* Effect.sleep(remaining);
        expect(yield* app.rows()).toEqual([{ id: control.row, label: "committed" }]);
        yield* evidence.json("confirmed-timeout.json", {
          app: app.app.id,
          control,
          timed: timed.id,
          marker,
          observed,
          status: failed.status,
        });
      }),
    ),
  );
  it.effect(
    scenarios.workflowSleep.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const hold = yield* Config.Number("E2E_WORKFLOW_HOLD_MS").pipe(
            Config.withDefault(1000),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 300000 })),
              ),
            ),
          );
          const app = yield* fixture;
          const evidence = yield* Evidence;
          const run = yield* app.start("sleep", { hold });
          const deadline = (yield* Clock.currentTimeMillis) + 40000;
          while ((yield* app.rows()).length === 0) {
            expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
            yield* Effect.sleep("250 millis");
          }
          yield* evidence.json("sleeping-workflow.json", {
            app: app.app.id,
            run: run.id,
            deployment: app.app.activeDeployment,
            hold,
            observed: yield* Clock.currentTimeMillis,
          });
          yield* Effect.logInfo(`Workflow sleep window: ${run.id}`);
          const completed = yield* app.wait(run.id, "complete", hold + 40000);
          const output = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ before: Schema.String, after: Schema.String, deadline: Schema.Number }),
          )(completed.output);
          expect(completed.deployment).toBe(app.app.activeDeployment);
          expect(yield* app.rows()).toEqual([
            { id: output.before, label: "before" },
            { id: output.after, label: "after" },
          ]);
          const fresh = yield* app.start("sleep", { hold: 1000 });
          yield* app.wait(fresh.id, "complete");
          expect((yield* app.rows()).map((row) => row.label)).toEqual([
            "before",
            "after",
            "before",
            "after",
          ]);
          yield* evidence.json("completed-workflow.json", {
            app: app.app.id,
            run: completed.id,
            fresh: fresh.id,
            output,
          });
        }),
      ),
    { timeout: 400000 },
  );
});
