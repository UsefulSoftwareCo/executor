/** Reproducible populated organizations created through the real product and provider APIs. */
import { Effect, Redacted, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
import { createProfile } from "../support/profiles.ts";
import { BaseUrl, emulatorRequest } from "../support/emulators.ts";

/** Bounded volumes are explicit; the seed controls data values while the scenario owns unique identities. */
export const DataShape = Schema.Struct({
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2147483647 })),
  apps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  accounts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  records: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
});
/** Ready-to-use populations; empty scenarios need no seeding operation. */
export const populations = {
  populated: { seed: 42, apps: 8, accounts: 32, records: 1000 },
  large: { seed: 42, apps: 24, accounts: 200, records: 10000 },
} as const;
/** Non-sensitive receipts let callers assert exact resources and replay the data shape. */
export const SeedReceipt = Schema.Struct({
  shape: DataShape,
  apps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      name: Schema.String,
      profile: Schema.String,
    }),
  ),
  accounts: Schema.Array(Schema.String),
  groups: Schema.Array(Schema.String),
  provider: Schema.Struct({ origin: Schema.String, repository: Schema.String }),
});

const source = (
  origin: string,
  owner: string,
) => `import {defineApp,defineProvider,secrets,defineDatabase,table,query,mutation,object,string,array} from "apps";
const service=defineProvider({name:"Scenario GitHub",auth:{token:secrets({label:"GitHub token",fields:object({token:string()})})}});
const database=defineDatabase({records:table({key:string(),title:string(),status:string(),body:string()})});
const record=object({key:string(),title:string(),status:string(),body:string()});
export default defineApp({accounts:{service},database},{
  queries:{
    summary:query({input:object({})},async({db})=>{const rows=await db.records.withIndex("by_creation").collect();return {count:rows.length,open:rows.filter(r=>r.status==="open").length,closed:rows.filter(r=>r.status==="closed").length,keys:rows.map(r=>r.key).sort()};}),
    repository:query({input:object({})},async ctx=>{const response=await fetch(${JSON.stringify(`${origin}/repos/${owner}/operations`)},{headers:{authorization:"Bearer "+ctx.accounts.service.fields.token}});if(!response.ok)throw new Error("Provider returned "+response.status);const repo=await response.json();return {name:repo.name,private:repo.private,owner:repo.owner.login};})
  },
  mutations:{seed:mutation({input:object({records:array(record)})},async({db},input)=>{for(const row of input.records)await db.records.insert(row);return {inserted:input.records.length};})}
});`;

/** Seed real apps, native account connections, group access and app storage; own the external emulator until scope exit. */
export const seedOrganization = (input: typeof DataShape.Type) =>
  Effect.gen(function* () {
    const shape = yield* Schema.decodeUnknownEffect(DataShape)(input);
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const instance = `scenario-${randomBytes(16).toString("hex")}`;
    const created = yield* emulatorRequest("https://github.emulators.dev", "/_emulate/instances", {
      instance,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ providerBaseUrl: BaseUrl }))),
    );
    yield* Effect.addFinalizer(() =>
      emulatorRequest(created.providerBaseUrl, "/_emulate/reset", {}).pipe(Effect.orDie),
    );
    const login = `scenario-${shape.seed}`;
    yield* emulatorRequest(created.providerBaseUrl, "/_emulate/seed", {
      users: [{ login, name: "Scenario operator", email: `${login}@example.test` }],
      repos: [
        {
          owner: login,
          name: "operations",
          private: true,
          description: "Synthetic operations repository",
          auto_init: true,
        },
      ],
    });
    const tokens = yield* Effect.forEach(
      Array.from({ length: shape.accounts }, (_, index) => index),
      () =>
        emulatorRequest(created.providerBaseUrl, "/_emulate/credentials", {
          type: "bearer-token",
          login,
          scopes: ["repo"],
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                credential: Schema.Struct({
                  token: Schema.RedactedFromValue(Schema.NonEmptyString),
                }),
              }),
            ),
          ),
          Effect.map((value) => value.credential.token),
        ),
      { concurrency: 8 },
    );
    const apps = yield* Effect.forEach(
      Array.from({ length: shape.apps }, (_, index) => index),
      (index) =>
        api
          .request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Operations ${String(index + 1).padStart(2, "0")}`,
            files: [{ path: "index.ts", content: source(created.providerBaseUrl, login) }],
          })
          .pipe(Effect.flatMap((response) => body(App, response))),
      { concurrency: 4 },
    );
    const first = apps[0];
    if (first === undefined)
      return yield* Effect.die(new Error("The data shape requires at least one app"));
    for (const app of apps) {
      const path = `${prefix}/apps/${app.id}/access`;
      const current = yield* body(
        Schema.Struct({ revision: Schema.String }),
        yield* api.request(actors.owner, "GET", path),
      );
      const shared = yield* api.request(actors.owner, "PATCH", path, {
        revision: current.revision,
        audience: { kind: "everyone" },
      });
      if (shared.status !== 200)
        return yield* Effect.die(new Error("Could not share the seeded app"));
    }
    const connections = yield* Effect.forEach(
      tokens,
      (token, index) =>
        Effect.gen(function* () {
          const actor = index % 2 === 0 ? actors.owner : actors.admin;
          const profile = yield* createProfile(actor, `${prefix}/apps/${first.id}`);
          const connection = yield* body(
            Resource,
            yield* api.request(actor, "POST", `${prefix}/apps/${first.id}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const saved = yield* body(
            Resource,
            yield* api.request(actor, "POST", `${prefix}/connections/${connection.id}/submit`, {
              method: "token",
              label: `${index % 3 === 0 ? "Support" : index % 3 === 1 ? "Engineering" : "Finance"} ${String(index + 1).padStart(3, "0")}`,
              fields: { token: Redacted.value(token) },
            }),
          );
          return { account: saved.id, profile: profile.id };
        }),
      { concurrency: 6 },
    );
    const primary = connections[0];
    if (primary === undefined)
      return yield* Effect.die(new Error("The data shape requires at least one account"));
    const configured = yield* Effect.forEach(
      apps,
      (app, index) =>
        Effect.gen(function* () {
          const profile =
            index === 0
              ? { id: primary.profile }
              : yield* body(
                  Resource,
                  yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/profiles`, {
                    idempotencyKey: randomBytes(16).toString("hex"),
                    accounts: { service: primary.account },
                  }),
                );
          return { ...app, profile: profile.id };
        }),
      { concurrency: 4 },
    );
    const rows = Array.from({ length: shape.records }, (_, index) => ({
      key: `record-${String(index).padStart(5, "0")}`,
      title: `${["Invoice", "Support request", "Release", "Customer report"][(index + shape.seed) % 4]} ${index + 1}`,
      status: (index + shape.seed) % 5 === 0 ? "closed" : "open",
      body:
        `Synthetic record ${index}, seed ${shape.seed}. ` +
        "Representative record content. ".repeat(1 + (index % 12)),
    }));
    for (let offset = 0; offset < rows.length; offset += 100) {
      const response = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/apps/${first.id}/tools/call`,
        {
          profile: primary.profile,
          tool: "mutations.seed",
          input: { records: rows.slice(offset, offset + 100) },
        },
      );
      const result = yield* body(Schema.Struct({ inserted: Schema.Number }), response);
      if (result.inserted !== Math.min(100, rows.length - offset))
        return yield* Effect.die(new Error("Seed did not persist every requested record"));
    }
    const member = yield* body(
      Schema.Struct({ userId: Schema.String }),
      yield* api.request(actors.member, "GET", "/api/viewer"),
    );
    const admin = yield* body(
      Schema.Struct({ userId: Schema.String }),
      yield* api.request(actors.admin, "GET", "/api/viewer"),
    );
    const directory = yield* body(
      Schema.Struct({
        members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
      }),
      yield* api.request(actors.owner, "GET", `${prefix}/groups`),
    );
    const memberId = directory.members.find((entry) => entry.userId === member.userId)?.id;
    const adminId = directory.members.find((entry) => entry.userId === admin.userId)?.id;
    if (memberId === undefined || adminId === undefined)
      return yield* Effect.die(new Error("Seed actors must be organization members"));
    const groups = yield* Effect.forEach(
      [
        { name: "Support", memberIds: [memberId] },
        { name: "Engineering", memberIds: [adminId] },
      ],
      (group) =>
        api
          .request(actors.owner, "POST", `${prefix}/groups`, {
            ...group,
            description: "Synthetic scenario group",
          })
          .pipe(Effect.flatMap((response) => body(Resource, response))),
      { concurrency: 2 },
    );
    const restricted = apps[1],
      engineering = groups[1];
    if (restricted !== undefined && engineering !== undefined) {
      const path = `${prefix}/apps/${restricted.id}/access`;
      const access = yield* body(
        Schema.Struct({ revision: Schema.String }),
        yield* api.request(actors.owner, "GET", path),
      );
      const response = yield* api.request(actors.owner, "PATCH", path, {
        revision: access.revision,
        audience: { kind: "groups", groups: [engineering.id] },
      });
      if (response.status !== 200)
        return yield* Effect.die(new Error("Could not seed group access"));
    }
    return SeedReceipt.make({
      shape,
      apps: configured,
      accounts: connections.map((entry) => entry.account),
      groups: groups.map((entry) => entry.id),
      provider: { origin: created.providerBaseUrl, repository: `${login}/operations` },
    });
  });
