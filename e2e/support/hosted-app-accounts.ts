/** Synthetic personal and shared accounts that members link to one hosted app. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { Actors } from "./actors.ts";
import { App, Inventory, Resource } from "./contracts.ts";
import type { Response } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";
import { connectionsPath, linkAccount } from "./app-accounts.ts";

export const Access = Schema.Struct({ revision: Schema.String });
/** The `who` tool's result: the context it ran in and the accounts it received. */
export const Who = Schema.Struct({
  context: Schema.Struct({ auth: Schema.Boolean, profile: Schema.Boolean }),
  account: Schema.String,
  extra: Schema.Array(Schema.String),
});
/** Require a successful `who` call and decode its result. */
export const who = (response: Response) =>
  Effect.gen(function* () {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return yield* body(Who, response);
  });
/** The fixture app's source. Its `service` requirement is the one the skill text depends on. */
export const appAccountsSource = `import { defineApp, defineProvider, secrets, query, mutation, workflow, userInterval, object, string, router,
  type QueryContext, type MutationContext, type WorkflowContext } from "apps";
const service = defineProvider({ name: "Linked account fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const requirements = { user: { accounts: { service, extra: service.many() } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  context: { auth: "auth" in ctx, profile: "profile" in ctx },
  account: ctx.user.accounts.service.id,
  extra: ctx.user.accounts.extra.map((account) => account.id),
}));
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements>) => {
  ctx.sql.exec("INSERT INTO ticks (account) VALUES (?)", ctx.user.accounts.service.id);
  return ctx.user.accounts.service.id;
});
const ticks = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec<{ account: string }>("SELECT account FROM ticks ORDER BY seq").toArray().map((row) => row.account));
const capture = workflow({ input: object({}) }, async (ctx: WorkflowContext<typeof requirements>) =>
  ctx.step.do("identity", async (step) => ({ context: { auth: "auth" in step, profile: "profile" in step }, account: step.user.accounts.service.id })));
export default defineApp(requirements, async (ctx) => ({
  tools: router({ who, tick, ticks }),
  workflows: { capture },
  schedules: { tick: userInterval({ minutes: 1 }, tick, {}) },
  skills: [{ name: "selected-account", description: "Instructions for the selected account", files: [{ path: "SKILL.md",
    content: "---\\nname: selected-account\\ndescription: Instructions for the selected account\\n---\\n" + ctx.user.accounts.service.id }] }],
}));`;
/** The fixture app's `ticks` table. */
export const appAccountsMigration = {
  path: "migrations/0001_ticks.sql",
  content: "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL);\n",
};

/**
 * An app everyone may use, with a personal account the member (Alice) and the admin (Bob) each
 * connected from the app for its plain `service` requirement, which links it there for them; their
 * many() `extra` requirement has no links yet. The owner links nothing.
 */
export const appAccountsFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Linked accounts ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: appAccountsSource }, appAccountsMigration, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  const accounts: { actor: Session; id: string }[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
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
  /**
   * Connect an account from the app for one of its user requirements, `service` unless named. The
   * connection links the new account to that requirement only, for the connecting member: it
   * replaces their link of a plain requirement and joins a many() one.
   */
  const connect = (
    actor: Session,
    label: string,
    options: { readonly shared?: boolean; readonly requirement?: string } = {},
  ) =>
    Effect.gen(function* () {
      const connection = yield* api.request(
        actor,
        "POST",
        connectionsPath(path, "user", options.requirement ?? "service"),
        {
          destination: options.shared
            ? { kind: "shared", audience: { kind: "everyone" } }
            : { kind: "personal" },
        },
      );
      expect(connection.status, JSON.stringify(connection.body)).toBe(200);
      const request = yield* body(Resource, connection);
      const response = yield* api.request(
        actor,
        "POST",
        `${prefix}/connections/${request.id}/submit`,
        { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const account = yield* body(Resource, response);
      accounts.push({ actor, id: account.id });
      return account.id;
    });
  const [mailA, mailB] = yield* Effect.all(
    [connect(actors.member, "Alice mail"), connect(actors.admin, "Bob mail")],
    { concurrency: 2 },
  );
  /** Call a tool as `actor`. It runs with the accounts `actor` linked to the app. */
  const call = (actor: Session, tool: "who" | "tick" | "ticks" = "who") =>
    api.request(actor, "POST", `${path}/tools/call`, {
      tool,
      kind: tool === "tick" ? "mutation" : "query",
      input: {},
    });
  /** The accounts `actor` links to this app, as the inventory reports them. */
  const inventoryLinks = (actor: Session) =>
    api.request(actor, "GET", `${prefix}/inventory`).pipe(
      Effect.flatMap((response) => body(Inventory, response)),
      Effect.map((inventory) =>
        inventory.links.filter((link) => link.app === app.id).map((link) => link.account),
      ),
    );
  return {
    api,
    actors,
    prefix,
    app,
    path,
    aliceId: aliceIdentity.userId,
    bobId: bobIdentity.userId,
    mailA,
    mailB,
    connect,
    call,
    inventoryLinks,
  };
});

/**
 * Bob shares an account with everyone, connecting it from the app for `service`, which replaces
 * his personal account there. Each member then uses the shared account for `service` and links
 * their personal account and the shared one, in that order, to `extra`.
 */
export const sharedAccountFixture = Effect.gen(function* () {
  const fixture = yield* appAccountsFixture;
  const { actors, path, connect, mailA, mailB } = fixture;
  const shared = yield* connect(actors.admin, "Shared mail", { shared: true });
  yield* linkAccount(actors.admin, path, "extra", mailB);
  yield* linkAccount(actors.admin, path, "extra", shared);
  yield* linkAccount(actors.member, path, "service", shared);
  yield* linkAccount(actors.member, path, "extra", mailA);
  yield* linkAccount(actors.member, path, "extra", shared);
  return { ...fixture, shared };
});
