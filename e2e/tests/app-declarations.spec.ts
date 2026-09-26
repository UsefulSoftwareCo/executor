/** Evaluated app declarations are reused only for identical inputs and never bypass live access. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

/** Declarations derived from the selected account's stored credential and the deployed version. */
const source = (
  version: string,
) => `import {defineApp,defineProvider,secrets,query,workflow,object,string} from "apps";
const service=defineProvider({name:"Declaration fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const ping=query({input:object({})},async()=>"pong");
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}}, async ctx => {
  const token=ctx.accounts.service.fields.token;
  return {
    queries:{ping},
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
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Declarations ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source("first") }],
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
          const reconnect = (actor: Session, account: string, token: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "POST",
                `${prefix}/accounts/${account}/connections`,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              expect(yield* submit(actor, (yield* body(Resource, response)).id, token)).toBe(
                account,
              );
            });
          /** The cache outcome recorded by the SDK span of the request's own trace. */
          const outcome = Effect.gen(function* () {
            const request = (yield* evidence.requests).at(-1);
            if (request === undefined) return yield* Effect.fail(new Error("Missing request"));
            const spans = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                const tagged = result.data.filter(
                  ({ span }) => span.tags["executor.declarations.cache"] !== undefined,
                );
                return tagged.length === 0
                  ? Effect.fail(new Error("Missing declaration read span"))
                  : Effect.succeed(tagged);
              }),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
            );
            expect(spans).toHaveLength(1);
            return spans[0]?.span.tags["executor.declarations.cache"];
          });
          const workflows = (actor: Session, profile: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "GET",
                `${path}/workflows?profile=${profile}`,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const names = (yield* body(Workflows, response)).map((workflow) => workflow.name);
              return { names, cache: yield* outcome };
            });
          const skills = (actor: Session, profile: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actor,
                "GET",
                `${path}/skill-bundle?profile=${profile}`,
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const bundle = yield* body(Bundle, response);
              return {
                descriptions: bundle.skills.map((skill) => skill.description),
                cache: yield* outcome,
              };
            });

          /**
           * An identical read reuses the kept result. A Cloud isolate keeps its own results in
           * memory only, and parallel scenarios spread reads over several isolates, so there a read
           * can land on isolates that have not evaluated these inputs yet. Every such read must be
           * a miss that returns the expected value, and one must eventually reuse.
           */
          const reused = <A extends { readonly cache: string | undefined }>(
            read: Effect.Effect<A, unknown>,
            expected: Omit<A, "cache">,
          ) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 8; attempt += 1) {
                const { cache, ...value } = yield* read;
                expect(value).toEqual(expected);
                if (cache === "hit" || cache === "stale") return;
                expect(target.metadata.target, `read ${attempt} was ${cache}`).toBe("cloud");
                expect(cache).toBe("miss");
              }
              return yield* Effect.fail(new Error("Identical reads never reused a kept result"));
            });

          const owned = yield* profile(actors.owner);
          const alpha = yield* connect(actors.owner, owned, "alpha");
          // A first evaluation is retained; an identical second read reuses it.
          expect(yield* workflows(actors.owner, owned)).toEqual({
            names: ["first_alpha"],
            cache: "miss",
          });
          yield* reused(workflows(actors.owner, owned), { names: ["first_alpha"] });
          expect(yield* skills(actors.owner, owned)).toEqual({
            descriptions: ["first guide for alpha"],
            cache: "miss",
          });
          yield* reused(skills(actors.owner, owned), { descriptions: ["first guide for alpha"] });

          // A replaced credential is a different evaluation input.
          yield* reconnect(actors.owner, alpha, "beta");
          expect(yield* workflows(actors.owner, owned)).toEqual({
            names: ["first_beta"],
            cache: "miss",
          });
          expect(yield* skills(actors.owner, owned)).toEqual({
            descriptions: ["first guide for beta"],
            cache: "miss",
          });

          // A new selection changes the profile revision.
          yield* connect(actors.owner, owned, "gamma");
          expect(yield* workflows(actors.owner, owned)).toEqual({
            names: ["first_gamma"],
            cache: "miss",
          });

          // Another member's profile is evaluated with that member's own account.
          const member = yield* profile(actors.member);
          yield* connect(actors.member, member, "delta");
          expect(yield* workflows(actors.member, member)).toEqual({
            names: ["first_delta"],
            cache: "miss",
          });
          yield* reused(workflows(actors.member, member), { names: ["first_delta"] });
          yield* reused(workflows(actors.owner, owned), { names: ["first_gamma"] });
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
            files: [{ path: "index.ts", content: source("second") }],
          });
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          expect(yield* workflows(actors.owner, owned)).toEqual({
            names: ["second_gamma"],
            cache: "miss",
          });
          expect(yield* skills(actors.owner, owned)).toEqual({
            descriptions: ["second guide for gamma"],
            cache: "miss",
          });
        }),
      ),
    { timeout: 120_000 },
  );
});
