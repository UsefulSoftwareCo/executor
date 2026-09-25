import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
/** Query budgets use SQL spans from real HTTP calls, including account and workflow results. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, workflow } from "apps";
const service = defineProvider({ name: "Query budget fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { workspaces: service.many() } }, async ctx => ({
  queries: { selected: query({ input: object({}) }, async () => ctx.accounts.workspaces.map(account => account.fields.token)) },
  workflows: { quick: workflow({ input: object({}) }, async () => "finished") }
}));`;

layer(HostedLive, { excludeTestServices: true })("SDK query budgets", (it) => {
  it.effect(scenarios.sdkQueryBudgets.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: string[] = [],
          runs: string[] = [];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Query budgets ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }],
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

        const traceId = Effect.gen(function* () {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined)
            return yield* Effect.die(new Error("Request evidence missing"));
          return request.traceId;
        });
        const queries = (id: string, operation: string) =>
          telemetry.query(id).pipe(
            Effect.flatMap((result) => {
              const root = result.data.find((entry) => entry.span.operationName === operation);
              const complete = result.data.some(
                (entry) => entry.span.tags["http.response.status_code"] === "200",
              );
              if (root === undefined || !complete)
                return Effect.fail(new Error("The completed server trace must reach Motel"));
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              const reads = result.data.filter(({ span }) => {
                if (span.operationName !== "sql.execute") return false;
                let parent = span.parentSpanId;
                const visited = new Set<string>();
                while (parent !== null && !visited.has(parent)) {
                  if (parent === root.span.spanId) return true;
                  visited.add(parent);
                  parent = byId.get(parent)?.parentSpanId ?? null;
                }
                return false;
              });
              return reads.length === 0
                ? Effect.fail(new Error("SQL descendants must reach Motel"))
                : Effect.succeed(reads);
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.timeout("25 seconds"),
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
          tool: "queries.selected",
          input: {},
        });
        expect(called.status).toBe(200);
        expect(called.body).toEqual(
          Array.from({ length: 10 }, (_, index) => `synthetic-${9 - index}`),
        );
        const invocationTrace = yield* traceId;
        const invocationQueries = yield* queries(invocationTrace, "sdk.invocation.snapshot");
        yield* evidence.json("invocation-query-budget.json", {
          traceId: invocationTrace,
          count: invocationQueries.length,
        });
        expect
          .soft(
            invocationQueries.length,
            "Ten accounts need one joined app read, one profile read and one account batch",
          )
          .toBe(3);
        const memberReads = yield* telemetry
          .query(invocationTrace)
          .pipe(
            Effect.map(
              (result) =>
                result.data.filter(
                  ({ span }) =>
                    span.operationName === "sql.execute" &&
                    String(span.tags["db.query.text"] ?? "").includes("from member where"),
                ).length,
            ),
          );
        yield* evidence.json("invocation-member-reads.json", {
          traceId: invocationTrace,
          count: memberReads,
        });
        expect
          .soft(memberReads, "The app, profile and ten account checks share one membership read")
          .toBe(1);
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
          tool: "queries.selected",
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
        const historyTrace = yield* traceId;
        const historyQueries = yield* queries(historyTrace, "sdk.workflows.list");
        yield* evidence.json("workflow-query-budget.json", {
          traceId: historyTrace,
          count: historyQueries.length,
        });
        expect
          .soft(historyQueries.length, "Twenty completed runs need one app read and one page read")
          .toBe(2);
      }),
    ),
  );
});
