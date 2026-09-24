import { createProfile } from "../support/profiles.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
/** Real HTTP coverage for durable app workflows, pinned execution, and product permissions. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";

import {
  workflowFiles as files,
  WorkflowApp as App,
  WorkflowRun as Run,
  WorkflowRows as Rows,
} from "../support/workflow-app.ts";

const workflowFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const name = `Workflow ${randomUUID().slice(0, 8)}`;
  const resources: {
    apps: string[];
    accounts: string[];
    runs: { app: string; id: string }[];
  } = { apps: [], accounts: [], runs: [] };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const run of resources.runs)
        yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${run.app}/workflow-runs/${run.id}/terminate`,
        );
      for (const app of resources.apps)
        expect((yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`)).status).toBe(
          200,
        );
      for (const account of resources.accounts)
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)).status,
        ).toBe(200);
    }).pipe(Effect.orDie),
  );
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: files("v1"),
  });
  expect(deployed.status).toBe(200);
  const app = yield* body(App, deployed);
  resources.apps.push(app.id);
  const path = `${prefix}/apps/${app.id}`;
  const submit = (connection: string, token: string) =>
    api.request(actors.owner, "POST", `${prefix}/connections/${connection}/submit`, {
      method: "key",
      label: name,
      fields: { token },
    });
  const profile = yield* createProfile(actors.owner, path);
  const connect = () =>
    Effect.gen(function* () {
      const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
        requirement: "service",
        profile: profile.id,
      });
      expect(pending.status).toBe(200);
      const saved = yield* submit((yield* body(Resource, pending)).id, "synthetic-original");
      expect(saved.status).toBe(200);
      const account = (yield* body(Resource, saved)).id;
      resources.accounts.push(account);
      return account;
    });
  const account = yield* connect();
  expect(
    (yield* api.request(actors.member, "GET", `${path}/workflows?profile=${profile.id}`)).status,
  ).toBe(403);
  const definitions = yield* api.request(
    actors.owner,
    "GET",
    `${path}/workflows?profile=${profile.id}`,
  );
  expect(definitions.status).toBe(200);
  expect(
    (yield* body(Schema.Array(Schema.Struct({ name: Schema.String })), definitions)).map(
      (w) => w.name,
    ),
  ).toContain("process");
  const start = (workflow: string, input: Schema.Json = {}, key: string = randomUUID()) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
        profile: profile.id,
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
        const response = yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${id}`);
        expect(response.status).toBe(200);
        const run = yield* body(Run, response);
        if (run.status === status) return run;
        expect(
          ["errored", "terminated", "complete"].includes(run.status),
          JSON.stringify(run),
        ).toBe(false);
        expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
        yield* Effect.sleep("100 millis");
      }
    });
  const call = (tool: string, input: Schema.Json = {}) =>
    api.request(actors.owner, "POST", `${path}/tools/call`, {
      profile: profile.id,
      tool,
      input,
    });
  return {
    api,
    actors,
    prefix,
    name,
    resources,
    app,
    path,
    submit,
    profile,
    connect,
    account,
    start,
    wait,
    call,
  };
});

layer(HostedLive, { excludeTestServices: true })("App workflows", (it) => {
  it.effect(scenarios.workflows.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          prefix,
          name,
          resources,
          app,
          path,
          submit,
          profile,
          connect,
          account,
          start,
          wait,
          call,
        } = yield* workflowFixture;
        expect(
          (yield* api.request(actors.member, "POST", `${path}/workflow-runs`, {
            profile: profile.id,
            workflow: "quick",
            input: {},
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
            profile: profile.id,
            workflow: "process",
            input: {},
          })).status,
        ).toBeGreaterThanOrEqual(400);
        const run = yield* start("process", { label: "pinned" }, name);
        expect((yield* start("process", { label: "pinned" }, name)).id).toBe(run.id);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
            profile: profile.id,
            workflow: "process",
            input: { label: "other" },
            key: name,
          })).status,
        ).toBeGreaterThanOrEqual(400);
        const isolation = yield* call("queries.isolation");
        expect(isolation.status).toBe(200);
        expect(isolation.body).toEqual({
          hostEnvironmentAtImport: false,
          hostEnvironmentAtCall: false,
          hostFileAccess: false,
        });
        const beforeDeadline = (yield* Clock.currentTimeMillis) + 15000;
        while ((yield* body(Rows, yield* call("queries.rows"))).length < 1) {
          expect(yield* Clock.currentTimeMillis).toBeLessThan(beforeDeadline);
          yield* Effect.sleep("100 millis");
        }
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)).status,
        ).toBe(409);
        expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(409);
        const reconnect = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/accounts/${account}/connections`,
        );
        expect(
          (yield* submit((yield* body(Resource, reconnect)).id, "synthetic-refreshed")).status,
        ).toBe(200);
        const second = yield* connect();
        expect(second).not.toBe(account);
        const updated = yield* saveAndDeploy(actors.owner, path, {
          files: files("v2"),
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const completed = yield* wait(run.id, "complete");
        expect(completed.deployment).toBe(app.activeDeployment);
        const output = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            version: Schema.String,
            first: Schema.Struct({
              source: Schema.String,
              attempts: Schema.Number,
              key: Schema.String,
            }),
            after: Schema.String,
            count: Schema.Number,
          }),
        )(completed.output);
        expect(output).toMatchObject({
          version: "v1",
          first: { source: "synthetic-original", attempts: 2 },
          after: "synthetic-refreshed",
          count: 3,
        });
        expect(output.first.key.length).toBe(64);
        expect(
          (yield* body(Rows, yield* call("queries.rows")))
            .filter((row) => row.label !== "pinned:before")
            .map((row) => row.source),
        ).toEqual(["synthetic-refreshed", "synthetic-refreshed"]);
        expect((yield* wait((yield* start("quick")).id, "complete")).output).toBe("v2");
        const launched = yield* call("mutations.launch", { key: name + "-handler" });
        expect(launched.status).toBe(200);
        const internal = yield* body(Run, launched);
        resources.runs.push({ app: app.id, id: internal.id });
        expect((yield* wait(internal.id, "complete")).output).toBe("v2");
        expect((yield* call("queries.history")).status).toBe(200);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `${path}/workflow-runs?profile=${profile.id}&limit=1`,
          )).status,
        ).toBe(403);
        const page = yield* body(
          Schema.Struct({ items: Schema.Array(Run), next: Schema.String }),
          yield* api.request(
            actors.owner,
            "GET",
            `${path}/workflow-runs?profile=${profile.id}&limit=1`,
          ),
        );
        expect(page.items.length).toBe(1);
        const next = yield* api.request(
          actors.owner,
          "GET",
          `${path}/workflow-runs?profile=${profile.id}&limit=1&cursor=${encodeURIComponent(page.next)}`,
        );
        expect(next.status).toBe(200);
        const nextPage = yield* body(Schema.Struct({ items: Schema.Array(Run) }), next);
        expect(nextPage.items.length).toBe(1);
        expect(nextPage.items[0]?.id).not.toBe(page.items[0]?.id);
        const other = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: name + " Other",
          files: [
            {
              path: "index.ts",
              content:
                'import { defineApp } from "apps"; export default defineApp({accounts:{}}, {});',
            },
          ],
        });
        expect(other.status).toBe(200);
        const otherApp = (yield* body(Resource, other)).id;
        resources.apps.push(otherApp);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${otherApp}/workflow-runs/${run.id}`,
          )).status,
        ).toBeGreaterThanOrEqual(400);
      }),
    ),
  );
  it.effect(scenarios.workflowFailures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, start, wait, call } = yield* workflowFixture;
        for (const [workflow, reason] of [
          ["deniedRun", "approval"],
          ["approvalRun", "approval"],
          ["interactiveRun", "execution"],
          ["fatal", "execution"],
        ] as const) {
          const failed = yield* wait((yield* start(workflow)).id, "errored");
          expect(failed.error).toBe(reason);
        }
        yield* wait((yield* start("timeoutRun")).id, "errored");
        expect(
          (yield* body(Rows, yield* call("queries.rows"))).some(
            (row) => row.label === "timeout:rollback",
          ),
        ).toBe(false);
        const slow = yield* start("slow");
        expect(
          (yield* api.request(actors.member, "POST", `${path}/workflow-runs/${slow.id}/terminate`))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${slow.id}/terminate`))
            .status,
        ).toBe(200);
        expect((yield* wait(slow.id, "terminated")).status).toBe("terminated");
        expect(
          (yield* body(Rows, yield* call("queries.rows"))).some(
            (row) => row.label === "cancel:after",
          ),
        ).toBe(false);
      }),
    ),
  );
});
