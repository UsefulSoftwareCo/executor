/** Evaluated app declarations follow their inputs and never bypass live access. */
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

/** Declarations derived from the selected account's stored credential and the deployed version. */
const source = (
  version: string,
) => `import {defineApp,defineProvider,secrets,query,workflow,object,string, router} from "apps";
const service=defineProvider({name:"Declaration fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({input:object({})},async()=>"pong");
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}}, async ctx => {
  const token=ctx.accounts.service.fields.token;
  return {
    tools: router({ ping }),
    workflows:{["${version}_"+token]:noop},
    skills:[{name:"account-guide",description:"${version} guide for "+token,files:[{path:"SKILL.md",content:"---\\nname: account-guide\\ndescription: ${version} guide for "+token+"\\n---\\n# "+token}]}],
  };
});`;
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));
const Bundle = Schema.Struct({
  deployment: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const Profile = Schema.Struct({ id: Schema.String, revision: Schema.Number });
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
          const profiles: { actor: Session; id: string }[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of profiles)
                yield* api.request(item.actor, "DELETE", `${path}/profiles/${item.id}`);
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
          const profile = (actor: Session) =>
            Effect.gen(function* () {
              const response = yield* api.request(actor, "POST", `${path}/profiles`, {
                accounts: {},
                idempotencyKey: randomUUID(),
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const created = yield* body(Profile, response);
              profiles.push({ actor, id: created.id });
              return created.id;
            });
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
          /** Connect a new personal account and select it in the profile. */
          const connect = (actor: Session, profile: string, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(actor, "POST", `${path}/connections`, {
                profile,
                requirement: "service",
                destination: { kind: "personal" },
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const account = yield* submit(actor, (yield* body(Resource, response)).id, token);
              accounts.push({ actor, id: account });
              return account;
            });
          /** Replace the stored credential of an existing account; its ID and selection stay. */
          const reconnect = (actor: Session, profile: string, account: string, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(actor, "POST", `${path}/connections`, {
                profile,
                requirement: "service",
                account,
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              expect(yield* submit(actor, (yield* body(Resource, response)).id, token)).toBe(
                account,
              );
            });
          const workflows = (actor: Session, profile: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "GET",
                `${path}/workflows?profile=${profile}`,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return (yield* body(Workflows, response)).map((workflow) => workflow.name);
            });
          const skills = (actor: Session, profile: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "GET",
                `${path}/skill-bundle?profile=${profile}`,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return (yield* body(Bundle, response)).skills.map((skill) => skill.description);
            });

          const owned = yield* profile(actors.owner);
          const alpha = yield* connect(actors.owner, owned, "alpha");
          // A first evaluation and an identical second read return the same declarations.
          expect(yield* workflows(actors.owner, owned)).toEqual(["first_alpha"]);
          expect(yield* workflows(actors.owner, owned)).toEqual(["first_alpha"]);
          expect(yield* skills(actors.owner, owned)).toEqual(["first guide for alpha"]);
          expect(yield* skills(actors.owner, owned)).toEqual(["first guide for alpha"]);

          // A replaced credential is a different evaluation input.
          yield* reconnect(actors.owner, owned, alpha, "beta");
          expect(yield* workflows(actors.owner, owned)).toEqual(["first_beta"]);
          expect(yield* skills(actors.owner, owned)).toEqual(["first guide for beta"]);

          // A new selection changes the profile revision.
          yield* connect(actors.owner, owned, "gamma");
          expect(yield* workflows(actors.owner, owned)).toEqual(["first_gamma"]);

          // Another member's profile is evaluated with that member's own account.
          const member = yield* profile(actors.member);
          yield* connect(actors.member, member, "delta");
          expect(yield* workflows(actors.member, member)).toEqual(["first_delta"]);
          expect(yield* workflows(actors.member, member)).toEqual(["first_delta"]);
          expect(yield* workflows(actors.owner, owned)).toEqual(["first_gamma"]);
          // Retained results never substitute for access: another subject's profile stays closed.
          expect(
            (yield* api.request(actors.member, "GET", `${path}/workflows?profile=${owned}`)).status,
          ).toBe(403);
          expect(
            (yield* api.request(actors.member, "GET", `${path}/skill-bundle?profile=${owned}`))
              .status,
          ).toBe(403);

          // Revoking the member's app access denies a read whose result is still retained.
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
          expect(
            (yield* api.request(actors.member, "GET", `${path}/workflows?profile=${member}`))
              .status,
          ).toBe(403);
          expect(
            (yield* api.request(actors.member, "GET", `${path}/skill-bundle?profile=${member}`))
              .status,
          ).toBe(403);

          // A new deployment is a new build: its declarations appear on the next read.
          const redeployed = yield* saveAndDeploy(actors.owner, path, {
            files: [{ path: "index.ts", content: source("second") }, appsManifest],
          });
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          expect(yield* workflows(actors.owner, owned)).toEqual(["second_gamma"]);
          expect(yield* skills(actors.owner, owned)).toEqual(["second guide for gamma"]);
        }),
      ),
    { timeout: 120_000 },
  );
});
