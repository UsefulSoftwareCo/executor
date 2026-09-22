/** Local product coverage uses the real bearer-protected SDK routes and its persistent engine. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import {
  workflowFiles,
  WorkflowRun as Run,
  WorkflowRows as Rows,
} from "../support/workflow-app.ts";
import { scenarios } from "../test-plan.ts";

const Deployment = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    activeDeployment: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });

layer(TestLive, { excludeTestServices: true })("Local workflows", (it) => {
  it.effect(scenarios.localWorkflows.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        // Local rejects browser-origin requests at its agent API. Keep evidence capture,
        // while using the host-issued bearer credential and the actual agent protocol.
        const agent: Session = {
          ...session,
          send: (method, path, data, headers = {}) => {
            const { origin: _origin, ...agentHeaders } = headers;
            return session.send(method, path, data, {
              ...agentHeaders,
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            });
          },
        };
        const owner = "workflow-e2e",
          accountOwner = "workflow-accounts-e2e",
          name = `Workflow ${randomUUID().slice(0, 8)}`;
        const resources: {
          apps: string[];
          accounts: string[];
          runs: { app: string; id: string }[];
        } = { apps: [], accounts: [], runs: [] };
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const run of resources.runs)
              yield* api.request(
                agent,
                "POST",
                `/v1/apps/${run.app}/workflow-runs/${run.id}/terminate`,
              );
            for (const app of resources.apps)
              expect((yield* api.request(agent, "DELETE", `/v1/apps/${app}`)).status).toBe(200);
            for (const account of resources.accounts)
              expect((yield* api.request(agent, "DELETE", `/v1/accounts/${account}`)).status).toBe(
                200,
              );
          }).pipe(Effect.orDie),
        );
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          name,
          files: workflowFiles("v1"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Deployment, deployed);
        resources.apps.push(app.id);
        const path = `/v1/apps/${app.id}`;
        const addAccount = (token: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(agent, "POST", "/v1/accounts", {
              owner: accountOwner,
              provider: app.requirements.accounts.service.provider,
              method: "key",
              label: name,
              fields: { token },
            });
            expect(created.status).toBe(200);
            const account = (yield* body(Resource, created)).id;
            resources.accounts.push(account);
            expect(
              (yield* api.request(agent, "PATCH", path, { accounts: { service: account } })).status,
            ).toBe(200);
            return account;
          });
        const account = yield* addAccount("synthetic-original");
        expect((yield* session.send("GET", `${path}/workflows`)).status).toBe(401);
        expect(
          (yield* api.request(session, "POST", `${path}/workflow-runs`, {
            workflow: "quick",
            input: {},
          })).status,
        ).toBeGreaterThanOrEqual(400);
        const definitions = yield* api.request(agent, "GET", `${path}/workflows`);
        expect(definitions.status).toBe(200);
        expect(
          (yield* body(Schema.Array(Schema.Struct({ name: Schema.String })), definitions)).map(
            (w) => w.name,
          ),
        ).toContain("process");
        const start = (workflow: string, input: Schema.Json = {}, key: string = randomUUID()) =>
          Effect.gen(function* () {
            const response = yield* api.request(agent, "POST", `${path}/workflow-runs`, {
              workflow,
              input,
              key,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const run = yield* body(Run, response);
            resources.runs.push({ app: app.id, id: run.id });
            return run;
          });
        const wait = (id: string, status: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 40000;
            while (true) {
              const response = yield* api.request(agent, "GET", `${path}/workflow-runs/${id}`);
              expect(response.status).toBe(200);
              const run = yield* body(Run, response);
              if (run.status === status) return run;
              expect(
                ["complete", "errored", "terminated"].includes(run.status),
                JSON.stringify(run),
              ).toBe(false);
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const call = (tool: string, input: Schema.Json = {}) =>
          Effect.gen(function* () {
            const response = yield* api.request(agent, "POST", "/v1/tools/call", {
              app: app.id,
              tool,
              input,
            });
            expect(response.status).toBe(200);
            return (yield* body(Completed, response)).value;
          });
        expect(yield* call("queries.isolation")).toEqual({
          hostEnvironmentAtImport: false,
          hostEnvironmentAtCall: false,
          hostFileAccess: false,
        });
        const rows = () =>
          call("queries.rows").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)));
        const run = yield* start("process", { label: "pinned" }, name);
        expect((yield* start("process", { label: "pinned" }, name)).id).toBe(run.id);
        expect(
          (yield* api.request(agent, "POST", `${path}/workflow-runs`, {
            workflow: "process",
            input: { label: "other" },
            key: name,
          })).status,
        ).toBeGreaterThanOrEqual(400);
        const deadline = (yield* Clock.currentTimeMillis) + 15000;
        while ((yield* rows()).length === 0) {
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("100 millis");
        }
        const blockedAppOwner = yield* api.request(agent, "DELETE", `/v1/owners/${owner}`);
        expect(blockedAppOwner.status).toBe(409);
        expect(blockedAppOwner.body).toMatchObject({ _tag: "AppWorkflowsActive", app: app.id });
        const blockedAccountOwner = yield* api.request(
          agent,
          "DELETE",
          `/v1/owners/${accountOwner}`,
        );
        expect(blockedAccountOwner.status).toBe(409);
        expect(blockedAccountOwner.body).toMatchObject({ _tag: "AccountWorkflowsActive", account });
        expect((yield* api.request(agent, "DELETE", path)).status).toBe(409);
        expect((yield* api.request(agent, "DELETE", `/v1/accounts/${account}`)).status).toBe(409);
        expect(
          (yield* api.request(agent, "PUT", `/v1/accounts/${account}/credentials`, {
            fields: { token: "synthetic-refreshed" },
          })).status,
        ).toBe(200);
        const second = yield* addAccount("synthetic-other");
        expect(second).not.toBe(account);
        const updated = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner,
          app: app.id,
          files: workflowFiles("v2"),
        });
        expect(updated.status).toBe(200);
        const complete = yield* wait(run.id, "complete");
        expect(complete.deployment).toBe(app.activeDeployment);
        expect(complete.output).toMatchObject({
          version: "v1",
          first: { source: "synthetic-original", attempts: 2 },
          after: "synthetic-refreshed",
          count: 3,
        });
        expect(
          (yield* rows()).filter((row) => row.label !== "pinned:before").map((row) => row.source),
        ).toEqual(["synthetic-refreshed", "synthetic-refreshed"]);
        const internal = yield* Schema.decodeUnknownEffect(Run)(
          yield* call("mutations.launch", { key: name + "-handler" }),
        );
        resources.runs.push({ app: app.id, id: internal.id });
        expect((yield* wait(internal.id, "complete")).output).toBe("v2");
        const history = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ items: Schema.Array(Run) }),
        )(yield* call("queries.history"));
        expect(history.items.length).toBe(1);
        const listed = yield* api.request(agent, "GET", `${path}/workflow-runs?limit=1`);
        expect(listed.status).toBe(200);
        expect(
          (yield* body(Schema.Struct({ items: Schema.Array(Run), next: Schema.String }), listed))
            .items.length,
        ).toBe(1);
        for (const [workflow, reason] of [
          ["deniedRun", "approval"],
          ["approvalRun", "approval"],
          ["interactiveRun", "execution"],
          ["fatal", "execution"],
        ] as const) {
          expect((yield* wait((yield* start(workflow)).id, "errored")).error).toBe(reason);
        }
        yield* wait((yield* start("timeoutRun")).id, "errored");
        expect((yield* rows()).some((row) => row.label === "timeout:rollback")).toBe(false);
        const slow = yield* start("slow");
        expect(
          (yield* api.request(agent, "POST", `${path}/workflow-runs/${slow.id}/terminate`)).status,
        ).toBe(200);
        expect((yield* wait(slow.id, "terminated")).status).toBe("terminated");
        expect((yield* rows()).some((row) => row.label === "cancel:after")).toBe(false);
        const purgedApp = yield* api.request(agent, "DELETE", `/v1/owners/${owner}`);
        expect(purgedApp.status).toBe(200);
        expect(purgedApp.body).toMatchObject({ apps: 1, accounts: 0 });
        resources.apps.length = 0;
        resources.runs.length = 0;
        const purgedAccounts = yield* api.request(agent, "DELETE", `/v1/owners/${accountOwner}`);
        expect(purgedAccounts.status).toBe(200);
        expect(purgedAccounts.body).toMatchObject({ apps: 0, accounts: 2 });
        resources.accounts.length = 0;
      }),
    ),
  );
});
