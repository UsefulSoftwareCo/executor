import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
/** Invocations read many selected accounts in saved order, and workflow history lists finished runs. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, workflow, router } from "apps";
const service = defineProvider({ name: "Query budget fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { workspaces: service.many() } }, async ctx => ({
  tools: router({
    selected: query({ input: object({}) }, async () => ctx.accounts.workspaces.map(account => account.fields.token)),
  }),
  workflows: { quick: workflow({ input: object({}) }, async () => "finished") }
}));`;

layer(HostedLive, { excludeTestServices: true })("SDK query budgets", (it) => {
  it.effect(scenarios.sdkQueryBudgets.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: string[] = [],
          runs: string[] = [];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Query budgets ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(Resource, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const run of runs)
              yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run}/terminate`);
            expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
            for (const account of accounts)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
          }).pipe(Effect.orDie),
        );

        const profile = yield* createProfile(actors.owner, path);
        for (let index = 0; index < 10; index++) {
          const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "workspaces",
            profile: profile.id,
          });
          expect(pending.status).toBe(200);
          const connection = yield* body(Resource, pending);
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "key",
              label: `Synthetic ${index}`,
              fields: { token: `synthetic-${index}` },
            },
          );
          expect(saved.status).toBe(200);
          accounts.push((yield* body(Resource, saved)).id);
        }
        // Deliberately reverse creation order: the batch read must retain saved binding order.
        const selected = [...accounts].reverse();
        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, { workspaces: selected }))
            .status,
        ).toBe(200);
        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool: "selected",
          kind: "query",
          input: {},
        });
        expect(called.status).toBe(200);
        expect(called.body).toEqual(
          Array.from({ length: 10 }, (_, index) => `synthetic-${9 - index}`),
        );
        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, {
            workspaces: [...selected, ...selected],
          })).status,
        ).toBeGreaterThanOrEqual(400);
        // Explicit empty selections remain valid and let the workflow fixture run without account pins.
        expect(
          (yield* selectProfileAccounts(actors.owner, path, profile.id, { workspaces: [] })).status,
        ).toBe(200);
        const empty = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          profile: profile.id,
          tool: "selected",
          kind: "query",
          input: {},
        });
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual([]);

        for (let index = 0; index < 20; index++) {
          const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
            profile: profile.id,
            workflow: "quick",
            input: {},
            key: randomUUID(),
          });
          expect(started.status).toBe(200);
          runs.push((yield* body(WorkflowRun, started)).id);
        }
        yield* Effect.forEach(
          runs,
          (id) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actors.owner,
                "GET",
                `${path}/workflow-runs/${id}`,
              );
              expect(response.status).toBe(200);
              const run = yield* body(WorkflowRun, response);
              return run.status === "complete"
                ? run
                : yield* Effect.fail(new Error("Workflow has not completed"));
            }).pipe(
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
              Effect.timeout("30 seconds"),
            ),
          { concurrency: 4 },
        );
        const listed = yield* api.request(actors.owner, "GET", `${path}/workflow-runs?limit=20`);
        expect(listed.status).toBe(200);
        const page = yield* body(
          Schema.Struct({
            items: Schema.Array(WorkflowRun),
            next: Schema.optionalKey(Schema.String),
          }),
          listed,
        );
        expect(page.items.map((run) => run.id)).toEqual([...runs].sort());
        expect(
          page.items.every((run) => run.status === "complete" && run.output === "finished"),
        ).toBe(true);
        expect(page.next).toBeUndefined();
      }),
    ),
  );
});
