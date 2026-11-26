import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import {
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
} from "../support/app-accounts.ts";

const source = (
  version: string,
) => `import {defineApp,defineProvider,secrets,query,workflow,object,string, router} from "apps";
const service=defineProvider({name:"Declaration fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({input:object({})},async()=>"pong");
const noop=workflow({input:object({})},async()=>null);
export default defineApp({user: { accounts:{service} }}, async ctx => {
  const token=ctx.user.accounts.service.fields.token;
  return {
    tools: router({ ping }),
    workflows:{["${version}_"+token]:noop},
    skills:[{name:"account-guide",description:"${version} guide for "+token,files:[{path:"SKILL.md",content:"---\\nname: account-guide\\ndescription: ${version} guide for "+token+"\\n---\\n# "+token}]}],
  };
});`;
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));
const Bundle = Schema.Struct({
  version: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const Access = Schema.Struct({ revision: Schema.String });

layer(HostedLive, { excludeTestServices: true })("App declarations", (it) => {
  it.effect(
    scenarios.appDeclarations.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Declarations ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source("first") }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const accounts: { actor: Session; id: string }[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              for (const item of accounts)
                yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
            }).pipe(Effect.orDie),
          );
          const everyone = yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `${path}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: everyone.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);
          const submit = (actor: Session, connection: string, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "POST",
                `${prefix}/connections/${connection}/submit`,
                { method: "key", label: `Account ${token}`, fields: { token } },
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return (yield* body(Resource, response)).id;
            });
          const connect = (actor: Session, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const account = yield* submit(actor, (yield* body(Resource, response)).id, token);
              accounts.push({ actor, id: account });
              return account;
            });
          const reconnect = (actor: Session, account: string, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "POST",
                connectionsPath(path, "user", "service"),
                {
                  account,
                },
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              expect(yield* submit(actor, (yield* body(Resource, response)).id, token)).toBe(
                account,
              );
            });
          const workflows = (actor: Session) =>
            Effect.gen(function* () {
              const response = yield* api.request(actor, "GET", `${path}/workflows`);
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return (yield* body(Workflows, response)).map((workflow) => workflow.name);
            });
          const skills = (actor: Session) =>
            Effect.gen(function* () {
              const response = yield* api.request(actor, "GET", `${path}/skill-bundle`);
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return (yield* body(Bundle, response)).skills.map((skill) => skill.description);
            });

          const alpha = yield* connect(actors.owner, "alpha");
          expect(yield* workflows(actors.owner)).toEqual(["first_alpha"]);
          expect(yield* workflows(actors.owner)).toEqual(["first_alpha"]);
          expect(yield* skills(actors.owner)).toEqual(["first guide for alpha"]);
          expect(yield* skills(actors.owner)).toEqual(["first guide for alpha"]);

          yield* reconnect(actors.owner, alpha, "beta");
          expect(yield* workflows(actors.owner)).toEqual(["first_beta"]);
          expect(yield* skills(actors.owner)).toEqual(["first guide for beta"]);

          const gamma = yield* connect(actors.owner, "gamma");
          expect(yield* linkedAccountIds(actors.owner, path)).toEqual([gamma]);
          expect(yield* workflows(actors.owner)).toEqual(["first_gamma"]);
          expect(yield* skills(actors.owner)).toEqual(["first guide for gamma"]);
          yield* linkAccount(actors.owner, path, "service", alpha);
          expect(yield* workflows(actors.owner)).toEqual(["first_beta"]);
          expect(yield* skills(actors.owner)).toEqual(["first guide for beta"]);
          yield* linkAccount(actors.owner, path, "service", gamma);

          yield* connect(actors.member, "delta");
          expect(yield* workflows(actors.member)).toEqual(["first_delta"]);
          expect(yield* workflows(actors.member)).toEqual(["first_delta"]);
          expect(yield* workflows(actors.owner)).toEqual(["first_gamma"]);
          expect((yield* linkAccountResponse(actors.member, path, "service", gamma)).status).toBe(
            403,
          );
          expect(yield* workflows(actors.member)).toEqual(["first_delta"]);
          expect(yield* skills(actors.member)).toEqual(["first guide for delta"]);

          const shared = yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `${path}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: shared.revision,
              audience: { kind: "private" },
            })).status,
          ).toBe(200);
          expect((yield* api.request(actors.member, "GET", `${path}/workflows`)).status).toBe(403);
          expect((yield* api.request(actors.member, "GET", `${path}/skill-bundle`)).status).toBe(
            403,
          );

          const redeployed = yield* saveAndDeploy(actors.owner, path, {
            files: [{ path: "index.ts", content: source("second") }, appsManifest],
          });
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          expect(yield* workflows(actors.owner)).toEqual(["second_gamma"]);
          expect(yield* skills(actors.owner)).toEqual(["second guide for gamma"]);
        }),
      ),
    { timeout: 120_000 },
  );
});
