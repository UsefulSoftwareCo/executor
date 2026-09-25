import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { Actors } from "./actors.ts";
import { App, Resource } from "./contracts.ts";
/** Synthetic personal profiles and connections owned by one hosted scenario. */
export const Profile = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  revision: Schema.Number,
  enabled: Schema.Boolean,
  status: Schema.String,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});
export const Access = Schema.Struct({ revision: Schema.String });
const source = `import {defineApp,defineProvider,secrets,query,mutation,workflow,interval,object,string} from "apps";
const service=defineProvider({name:"Personal profile fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const who=query({input:object({})},async ctx=>({context:{auth:"auth" in ctx,profile:"profile" in ctx},account:ctx.accounts.service.id,extra:ctx.accounts.extra.map(a=>a.id)}));
const tick=mutation({input:object({})},async ctx=>ctx.accounts.service.id);
const capture=workflow({input:object({})},async ctx=>ctx.step.do("identity",async step=>({context:{auth:"auth" in step,profile:"profile" in step},account:step.accounts.service.id})));
export default defineApp({accounts:{service,extra:service.many()}}, async ctx => ({queries:{who},mutations:{tick},workflows:{capture},schedules:{tick:interval({minutes:1},tick,{})}, skills: [{name:"selected-account",description:"Instructions for the selected account",files:[{path:"SKILL.md",content:"---\\nname: selected-account\\ndescription: Instructions for the selected account\\n---\\n"+ctx.accounts.service.id}]}]}));`;
export const profileFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Personal app ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  const accounts: { actor: Session; id: string }[] = [],
    installed: { actor: Session; id: string }[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const item of installed)
        yield* api.request(item.actor, "DELETE", `${path}/profiles/${item.id}`);
      yield* api.request(actors.owner, "DELETE", path);
      for (const item of accounts)
        yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
    }).pipe(Effect.orDie),
  );
  const access = yield* body(Access, yield* api.request(actors.owner, "GET", `${path}/access`));
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  const identity = (actor: Session) =>
    api
      .request(actor, "GET", "/api/viewer")
      .pipe(Effect.flatMap((response) => body(Schema.Struct({ userId: Schema.String }), response)));
  const [aliceIdentity, bobIdentity] = yield* Effect.all(
    [identity(actors.member), identity(actors.admin)],
    { concurrency: 2 },
  );
  const aliceId = aliceIdentity.userId,
    bobId = bobIdentity.userId;
  const create = (actor: Session) =>
    api
      .request(actor, "POST", `${path}/profiles`, {
        accounts: { extra: [] },
        idempotencyKey: "personal",
        subject: "forged-subject",
      })
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
        ),
        Effect.flatMap((response) => body(Profile, response)),
      );
  let [alice, bob] = yield* Effect.all([create(actors.member), create(actors.admin)], {
    concurrency: 2,
  });
  installed.push({ actor: actors.member, id: alice.id }, { actor: actors.admin, id: bob.id });
  expect(alice.subject).toBe(aliceId);
  expect(bob.subject).toBe(bobId);
  const inventoryProfiles = (actor: Session) =>
    api.request(actor, "GET", `${prefix}/inventory`).pipe(
      Effect.flatMap((response) =>
        body(Schema.Struct({ profiles: Schema.Array(Profile) }), response),
      ),
      Effect.map((inventory) => inventory.profiles.map((profile) => profile.id)),
    );
  expect(yield* inventoryProfiles(actors.member)).toContain(alice.id);
  expect(yield* inventoryProfiles(actors.member)).not.toContain(bob.id);
  expect(yield* inventoryProfiles(actors.admin)).toContain(bob.id);
  expect(yield* inventoryProfiles(actors.owner)).not.toContain(alice.id);
  expect(alice.id).not.toBe(bob.id);
  const connect = (actor: Session, profile: string, label: string, shared = false) =>
    Effect.gen(function* () {
      const connection = yield* api.request(actor, "POST", `${path}/connections`, {
        profile,
        requirement: "service",
        destination: shared
          ? { kind: "shared", audience: { kind: "everyone" } }
          : { kind: "personal" },
      });
      expect(connection.status, JSON.stringify(connection.body)).toBe(200);
      const request = yield* body(Resource, connection);
      const response = yield* api.request(
        actor,
        "POST",
        `${prefix}/connections/${request.id}/submit`,
        { method: "key", label, fields: { token: "synthetic-profile-key" } },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const account = yield* body(Resource, response);
      accounts.push({ actor, id: account.id });
      return account.id;
    });
  const [mailA, mailB] = yield* Effect.all(
    [connect(actors.member, alice.id, "Alice mail"), connect(actors.admin, bob.id, "Bob mail")],
    { concurrency: 2 },
  );
  const get = (actor: Session, id: string) =>
    api
      .request(actor, "GET", `${path}/profiles/${id}`)
      .pipe(Effect.flatMap((response) => body(Profile, response)));
  alice = yield* get(actors.member, alice.id);
  bob = yield* get(actors.admin, bob.id);
  const call = (actor: Session, profile: string) =>
    api.request(actor, "POST", `${path}/tools/call`, {
      profile,
      tool: "queries.who",
      input: {},
    });
  return {
    api,
    actors,
    prefix,
    app,
    path,
    alice,
    bob,
    mailA,
    mailB,
    connect,
    get,
    call,
    inventoryProfiles,
  };
});

/** Select one shared account before checking scheduled execution or live revocation. */
export const sharedProfileFixture = Effect.gen(function* () {
  const fixture = yield* profileFixture;
  const { api, actors, path, mailA, bob, connect, get, call } = fixture;
  let { alice } = fixture;
  const shared = yield* connect(actors.admin, bob.id, "Shared mail", true);
  alice = yield* get(actors.member, alice.id);
  expect(
    (yield* api.request(actors.member, "PATCH", `${path}/profiles/${alice.id}`, {
      expectedRevision: alice.revision,
      accounts: { service: shared, extra: [mailA, shared] },
    })).status,
  ).toBe(200);
  expect((yield* call(actors.member, alice.id)).body).toMatchObject({
    account: shared,
    extra: [mailA, shared],
  });
  expect((yield* call(actors.member, bob.id)).status).toBe(403);
  expect((yield* api.request(actors.owner, "GET", `${path}/profiles`)).body).toEqual([]);
  return { ...fixture, alice, shared };
});
