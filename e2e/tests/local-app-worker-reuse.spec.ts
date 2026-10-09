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
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
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

/** Deploy an observer app through the agent API and return its per-profile operations. */
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
    // Remove the app before the accounts its profiles select.
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
    const owner = "worker-reuse-e2e",
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
        const created = yield* api.request(agent, "POST", "/v1/accounts", {
          owner,
          provider: app.requirements.accounts.service.provider,
          method: "key",
          label: name,
          fields: { token },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const account = (yield* body(Resource, created)).id;
        resources.accounts.push(account);
        const profile = yield* createProfile(agent, path, { owner, subject: "local" });
        expect(
          (yield* selectProfileAccounts(agent, path, profile.id, { service: account })).status,
        ).toBe(200);
        return { account, profile: profile.id };
      });
    const observe = (profile: string) =>
      Effect.gen(function* () {
        // The call names its kind, as agents do. Without one the host first describes the tool,
        // which cold-starts the app Worker beside the data facet that runs the query.
        const response = yield* api.request(agent, "POST", "/v1/tools/call", {
          app: app.id,
          profile,
          tool: "probe",
          kind: "query",
          input: {},
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* Schema.decodeUnknownEffect(Observation)(
          (yield* body(Completed, response)).value,
        );
      });
    const run = (profile: string) =>
      Effect.gen(function* () {
        const started = yield* api.request(agent, "POST", `${path}/workflow-runs`, {
          profile,
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
    return { agent, api, app: app.id, connect, observe, run };
  });

layer(TestLive, { excludeTestServices: true })("Local app worker reuse", (it) => {
  it.effect(scenarios.localAppWorkerReuse.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* oauthSetupIssuer;
        const { agent, api, app, connect, observe, run } = yield* localApp(
          `${issuer.origin}/resource`,
        );
        const first = yield* connect("synthetic-local-0");
        const observed: Array<typeof Observation.Type> = [yield* run(first.profile)];
        for (let round = 1; round <= rotations; round++) {
          const token = `synthetic-local-${round}`;
          const replaced = yield* api.request(
            agent,
            "PUT",
            `/v1/accounts/${first.account}/credentials`,
            { fields: { token } },
          );
          expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
          const call = yield* observe(first.profile);
          const workflow = yield* run(first.profile);
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
        const other = yield* run(second.profile);
        expect(other).toMatchObject({ previous: null, token: "synthetic-local-other" });
        expect(other.isolate).not.toBe(observed[0]!.isolate);
        expect((yield* observe(second.profile)).isolate).toBe(other.isolate);
        const back = yield* observe(first.profile);
        expect(back).toMatchObject({
          isolate: observed[0]!.isolate,
          previous: `synthetic-local-${rotations}`,
          token: `synthetic-local-${rotations}`,
        });
        // Each account's Worker loaded the build once, whether a workflow run, a call or profile
        // setup started it. A workflow cold start records its load under the Worker's name.
        const loads = yield* appBuildLoads(app);
        expect(Object.values(loads), JSON.stringify(loads)).toEqual([1, 1]);
        expect(Object.keys(loads).every((runtime) => runtime.startsWith("worker "))).toBe(true);
      }),
    ),
  );
});
