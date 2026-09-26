/**
 * Local evaluated declarations follow credentials and deployments at once, are served stale for
 * one read while a background evaluation replaces them, and are never served past 60 seconds.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

/** Each evaluation names its workflow after the version, the stored token and the clock. */
const source = (
  version: string,
) => `import {defineApp,defineProvider,secrets,query,workflow,object,string} from "apps";
const service=defineProvider({name:"Declaration clock",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({input:object({})},async()=>"pong");
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}}, async ctx => ({
  queries:{ping},
  workflows:{["${version}_"+ctx.accounts.service.fields.token+"_"+Date.now()]:noop},
}));`;
const Deployment = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));

layer(TestLive, { excludeTestServices: true })("Local app declarations", (it) => {
  it.effect(
    scenarios.localAppDeclarations.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            target = yield* Target,
            session = yield* api.session();
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
          const owner = "declarations-e2e",
            accountOwner = "declarations-accounts-e2e";
          const resources: { apps: string[]; accounts: string[] } = { apps: [], accounts: [] };
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const app of resources.apps)
                yield* api.request(agent, "DELETE", `/v1/apps/${app}`);
              for (const account of resources.accounts)
                yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
            owner,
            name: `Declarations ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source("first") }],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const { app } = yield* body(Deployment, deployed);
          resources.apps.push(app.id);
          const path = `/v1/apps/${app.id}`;
          const profile = yield* createProfile(agent, path, { owner, subject: "local" });
          const created = yield* api.request(agent, "POST", "/v1/accounts", {
            owner: accountOwner,
            provider: app.requirements.accounts.service.provider,
            method: "key",
            label: "Declaration clock",
            fields: { token: "alpha" },
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const account = (yield* body(Resource, created)).id;
          resources.accounts.push(account);
          expect(
            (yield* selectProfileAccounts(agent, path, profile.id, { service: account })).status,
          ).toBe(200);
          const read = Effect.gen(function* () {
            const response = yield* api.request(
              agent,
              "GET",
              `${path}/workflows?profile=${profile.id}`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const names = (yield* body(Workflows, response)).map((workflow) => workflow.name);
            expect(names).toHaveLength(1);
            return names[0] ?? "";
          });

          // An identical read within the fresh period reuses the evaluation.
          const first = yield* read;
          expect(first).toMatch(/^first_alpha_\d+$/);
          expect(yield* read).toBe(first);

          // A replaced credential and a new deployment are new evaluation inputs.
          expect(
            (yield* api.request(agent, "PUT", `/v1/accounts/${account}/credentials`, {
              fields: { token: "beta" },
            })).status,
          ).toBe(200);
          const reconnected = yield* read;
          expect(reconnected).toMatch(/^first_beta_\d+$/);
          expect(yield* read).toBe(reconnected);
          const redeployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
            owner,
            app: app.id,
            files: [{ path: "index.ts", content: source("second") }],
          });
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          const current = yield* read;
          expect(current).toMatch(/^second_beta_\d+$/);

          // Past the fresh period, one read still returns the kept result while a background
          // evaluation replaces it; a later read returns the replacement without evaluating.
          yield* Effect.sleep("11 seconds");
          expect(yield* read).toBe(current);
          let refreshed = current;
          for (let attempt = 0; attempt < 40 && refreshed === current; attempt += 1) {
            yield* Effect.sleep("250 millis");
            refreshed = yield* read;
          }
          expect(refreshed).not.toBe(current);
          expect(refreshed).toMatch(/^second_beta_\d+$/);
          expect(yield* read).toBe(refreshed);

          // Nothing kept is served past the hard bound: the next read evaluates first.
          yield* Effect.sleep("61 seconds");
          const expired = yield* read;
          expect(expired).not.toBe(refreshed);
          expect(expired).toMatch(/^second_beta_\d+$/);
          expect(yield* read).toBe(expired);
        }),
      ),
    { timeout: 180_000 },
  );
});
