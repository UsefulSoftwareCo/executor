/**
 * Local evaluated declarations follow credentials and deployments at once, are served stale for
 * one read while a background evaluation replaces them, and are still served that way past a minute.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Each evaluation names its workflow after the version, the stored token and the clock. */
const source = (
  version: string,
) => `import {defineApp,defineProvider,secrets,query,workflow,object,string, router} from "apps";
const service=defineProvider({name:"Declaration clock",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({input:object({})},async()=>"pong");
const noop=workflow({input:object({})},async()=>null);
export default defineApp({user: { accounts:{service} }}, async ctx => ({
  tools: router({ ping }),
  workflows:{["${version}_"+ctx.user.accounts.service.fields.token+"_"+Date.now()]:noop},
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
          const owner = "local";
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
            files: [{ path: "index.ts", content: source("first") }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const { app } = yield* body(Deployment, deployed);
          resources.apps.push(app.id);
          const path = `/v1/apps/${app.id}`;
          // Connect an account for the app, or replace the given account's key.
          const connect = (token: string, account?: string) =>
            connectLocalAccount(agent, {
              app: app.id,
              requirement: "service",
              method: "key",
              label: "Declaration clock",
              fields: { token },
              ...(account === undefined ? {} : { account }),
            });
          const account = (yield* connect("alpha")).id;
          resources.accounts.push(account);
          const read = Effect.gen(function* () {
            // The read uses the account linked to the app; agents do not choose one.
            const response = yield* api.request(agent, "GET", `${path}/workflows`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const names = (yield* body(Workflows, response)).map((workflow) => workflow.name);
            expect(names).toHaveLength(1);
            return names[0] ?? "";
          });

          // An identical read within the fresh period reuses the evaluation.
          const first = yield* read;
          expect(first).toMatch(/^first_alpha_\d+$/);
          expect(yield* read).toBe(first);

          // A reconnected credential and a new deployment are new evaluation inputs.
          expect((yield* connect("beta", account)).id).toBe(account);
          const reconnected = yield* read;
          expect(reconnected).toMatch(/^first_beta_\d+$/);
          expect(yield* read).toBe(reconnected);
          const redeployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
            owner,
            app: app.id,
            files: [{ path: "index.ts", content: source("second") }, appsManifest],
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

          // A minute later the kept result is still served first, well inside the day-long bound,
          // and the background evaluation it starts replaces it.
          yield* Effect.sleep("61 seconds");
          expect(yield* read).toBe(refreshed);
          let later = refreshed;
          for (let attempt = 0; attempt < 40 && later === refreshed; attempt += 1) {
            yield* Effect.sleep("250 millis");
            later = yield* read;
          }
          expect(later).not.toBe(refreshed);
          expect(later).toMatch(/^second_beta_\d+$/);
          expect(yield* read).toBe(later);
        }),
      ),
    { timeout: 180_000 },
  );
});
