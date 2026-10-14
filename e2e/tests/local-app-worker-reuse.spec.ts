/**
 * Local runs apps in the same workerd runtime as self-host. An app's Worker is named by its code
 * and account selection, so replacing a saved key or starting a workflow run reuses it. The
 * runtime's build loads and cold start recovery are the same code on both hosts; the self-host
 * scenarios in app-worker-reuse.spec.ts cover them.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal } from "../support/local-links.ts";
import { appBuildLoads } from "../support/build-loads.ts";
import { Observation, observerApp, RunObservation } from "../support/worker-observer.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Key replacements, each followed by one tool call and one workflow run. */
const rotations = 12;
const Deployment = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
});

/** Deploy an observer app through the agent API and return its per-account operations. */
const localApp = (resource: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      target = yield* Target,
      session = yield* api.session();
    // The agent API takes the host-issued bearer credential, not a browser origin.
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
    const resources: { app?: string; accounts: string[] } = { accounts: [] };
    // Remove the app before the accounts linked to it.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (resources.app !== undefined)
          expect((yield* api.request(agent, "DELETE", `/v1/apps/${resources.app}`)).status).toBe(
            200,
          );
        for (const account of resources.accounts)
          expect((yield* api.request(agent, "DELETE", `/v1/accounts/${account}`)).status).toBe(200);
      }).pipe(Effect.orDie),
    );
    const owner = "local",
      name = `Worker reuse ${randomUUID().slice(0, 8)}`;
    const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
      owner,
      name,
      files: [
        {
          path: "index.ts",
          content: observerApp({ name, database: false, resource }),
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const { app } = yield* body(Deployment, deployed);
    resources.app = app.id;
    const path = `/v1/apps/${app.id}`;
    const connect = (token: string) =>
      Effect.gen(function* () {
        const account = (yield* connectAccount({ token })).id;
        resources.accounts.push(account);
        return account;
      });
    /** Save an account for the app's requirement, or replace the given account's key. */
    const connectAccount = (input: { token: string; account?: string }) =>
      connectLocalAccount(agent, {
        app: app.id,
        requirement: "service",
        method: "key",
        label: name,
        fields: { token: input.token },
        ...(input.account === undefined ? {} : { account: input.account }),
      });
    // Calls cannot choose accounts: each one uses the account linked to the app, so the account a
    // call or run should use is linked first. Linking it again changes nothing.
    const observe = (account: string) =>
      Effect.gen(function* () {
        yield* linkLocal(agent, app.id, "service", account);
        // The call names its kind, as agents do. Without one the host first describes the tool,
        // which cold-starts the app Worker beside the data facet that runs the query.
        const response = yield* api.request(agent, "POST", "/v1/tools/call", {
          app: app.id,
          tool: "probe",
          kind: "query",
          input: {},
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* Schema.decodeUnknownEffect(Observation)(
          (yield* body(Completed, response)).value,
        );
      });
    const run = (account: string) =>
      Effect.gen(function* () {
        yield* linkLocal(agent, app.id, "service", account);
        const started = yield* api.request(agent, "POST", `${path}/workflow-runs`, {
          workflow: "probe",
          input: {},
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { id } = yield* body(Run, started);
        const deadline = (yield* Clock.currentTimeMillis) + 30_000;
        while (true) {
          const response = yield* api.request(agent, "GET", `${path}/workflow-runs/${id}`);
          expect(response.status).toBe(200);
          const current = yield* body(Run, response);
          if (current.status === "complete")
            return {
              id,
              ...(yield* Schema.decodeUnknownEffect(RunObservation)(current.output)),
            };
          expect(["errored", "terminated"].includes(current.status), JSON.stringify(current)).toBe(
            false,
          );
          expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
          yield* Effect.sleep("100 millis");
        }
      });
    return { agent, api, app: app.id, connect, connectAccount, observe, run };
  });

layer(TestLive, { excludeTestServices: true })("Local app worker reuse", (it) => {
  it.effect(scenarios.localAppWorkerReuse.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* oauthSetupIssuer;
        const { app, connect, connectAccount, observe, run } = yield* localApp(
          `${issuer.origin}/resource`,
        );
        const first = yield* connect("synthetic-local-0");
        const observed: Array<typeof Observation.Type> = [yield* run(first)];
        for (let round = 1; round <= rotations; round++) {
          const token = `synthetic-local-${round}`;
          const replaced = yield* connectAccount({ token, account: first });
          expect(replaced.id).toBe(first);
          const call = yield* observe(first);
          const workflow = yield* run(first);
          expect(workflow.run).toBe(workflow.id);
          // Each call and run presents the current key, also through its outbound fetch.
          for (const entry of [call, workflow])
            expect(entry).toMatchObject({ token, fetched: `Bearer ${token}` });
          observed.push(call, workflow);
        }
        // Key replacements, calls and workflow runs of one account reuse one loaded Worker.
        expect(new Set(observed.map((entry) => entry.isolate)).size).toBe(1);
        expect(observed.map((entry) => entry.calls)).toEqual(
          observed.map((_, index) => observed[0]!.calls + index),
        );

        // Another account's calls and runs use another Worker, with no module state from the first.
        const second = yield* connect("synthetic-local-other");
        const other = yield* run(second);
        expect(other).toMatchObject({ previous: null, token: "synthetic-local-other" });
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        expect((yield* observe(second)).isolate).toBe(other.isolate);
        const back = yield* observe(first);
        expect(back).toMatchObject({
          isolate: observed[0]!.isolate,
          previous: `synthetic-local-${rotations}`,
          token: `synthetic-local-${rotations}`,
        });
        // Each account's Worker loaded the build once, whether a workflow run or a call started it.
        // A workflow cold start records its load under the Worker's name.
        const loads = yield* appBuildLoads(app);
        expect(Object.values(loads), JSON.stringify(loads)).toEqual([1, 1]);
        expect(Object.keys(loads).every((runtime) => runtime.startsWith("worker "))).toBe(true);
      }),
    ),
  );
});
