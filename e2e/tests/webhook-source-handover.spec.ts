/** A shared account's webhook source moves to another linking member when its actor stops using it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  requirementPath,
  unlinkAccount,
} from "../support/app-accounts.ts";
import {
  webhookSources,
  removeAppWhenStopped,
  settleWebhookSources,
  settleWebhookSubscriptions,
  type WebhookSourceRow,
  type WebhookSubscriptionRow,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Viewer = Schema.Struct({ userId: Schema.String });
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const Directory = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const source = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Handover fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({}),state:object({}),
  register:async()=>({}),unregister:async()=>{},
  handle:async ctx=>Response.json({account:ctx.user.accounts.service.id,token:ctx.user.accounts.service.fields.token})};
export default defineApp({user: { accounts:{service} }},{tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`;

/** A deployed webhook app every member can use, removed with its links and accounts. */
const handoverFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const app = yield* body(
    App,
    yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Handover ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: source }, appsManifest],
    }),
  );
  const path = `${prefix}/apps/${app.id}`;
  const accounts: string[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const members = [actors.owner, actors.admin, actors.member];
      for (const actor of members)
        for (const account of accounts)
          yield* api.request(
            actor,
            "DELETE",
            `${requirementPath(path, "user", "service")}/${account}`,
          );
      yield* removeAppWhenStopped(actors.owner, path);
      for (const account of accounts)
        yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
    }).pipe(Effect.orDie),
  );
  const access = yield* body(
    Schema.Struct({ revision: Schema.String }),
    yield* api.request(actors.owner, "GET", `${path}/access`),
  );
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  const userIds = yield* Effect.forEach([actors.owner, actors.admin, actors.member], (actor) =>
    api.request(actor, "GET", "/api/viewer").pipe(
      Effect.flatMap((read) => body(Viewer, read)),
      Effect.map((viewer) => viewer.userId),
    ),
  );
  const [owner, admin, member] = userIds;
  if (owner === undefined || admin === undefined || member === undefined)
    return yield* Effect.die(new Error("Missing viewers"));
  /** Connect a shared account from the app, which links it for the connecting member. */
  const connectShared = (actor: Session, audience: unknown) =>
    Effect.gen(function* () {
      const connection = yield* body(
        Resource,
        yield* api.request(actor, "POST", connectionsPath(path, "user", "service"), {
          destination: { kind: "shared", audience },
        }),
      );
      const saved = yield* api.request(
        actor,
        "POST",
        `${prefix}/connections/${connection.id}/submit`,
        { method: "key", label: "Shared handover", fields: { token: "synthetic-handover" } },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const account = (yield* body(Resource, saved)).id;
      accounts.push(account);
      return account;
    });
  /** Wait until the account's only source runs as `actor` and is registered. */
  const sourceRunsAs = (reader: Session, account: string, actor: string) =>
    settleWebhookSources(
      reader,
      path,
      (sources: readonly WebhookSourceRow[]) =>
        sources.length === 1 &&
        sources[0]?.account === account &&
        sources[0].actor === actor &&
        sources[0].status === "ready",
    );
  /** The account's active subscription, once it runs as `actor`. */
  const subscriptionRunsAs = (reader: Session, account: string, actor: string) =>
    settleWebhookSubscriptions(reader, path, (hooks) => {
      const active = hooks.filter(
        (hook) => hook.sourceAccount === account && hook.status === "active",
      );
      return active.length === 1 && active[0]?.actor === actor;
    }).pipe(
      Effect.map((hooks) =>
        hooks.filter((hook) => hook.sourceAccount === account && hook.status === "active"),
      ),
      Effect.flatMap(([hook]) =>
        hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
      ),
    );
  /** Deliver an anonymous callback and require the source account to handle it. */
  const deliver = (callbackUrl: string, account: string) =>
    Effect.gen(function* () {
      const delivered = yield* api.request(
        yield* api.session(),
        "POST",
        new URL(callbackUrl).pathname,
        {},
      );
      expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
      expect(delivered.body).toEqual({ account, token: "synthetic-handover" });
    });
  return {
    api,
    actors,
    prefix,
    path,
    ids: { owner, admin, member },
    connectShared,
    sourceRunsAs,
    subscriptionRunsAs,
    deliver,
  };
});

layer(HostedLive, { excludeTestServices: true })("Webhook source handover", (it) => {
  it.effect(scenarios.webhookSourceUnlinkHandover.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connectShared, sourceRunsAs, subscriptionRunsAs, deliver } =
          yield* handoverFixture;
        const account = yield* connectShared(actors.owner, { kind: "everyone" });
        // The first member to link an account runs its webhook source.
        yield* sourceRunsAs(actors.owner, account, ids.owner);
        yield* linkAccount(actors.member, path, "service", account);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([account]);
        const first = yield* subscriptionRunsAs(actors.owner, account, ids.owner);
        yield* sourceRunsAs(actors.owner, account, ids.owner);
        yield* deliver(first.callbackUrl, account);
        // When the actor unlinks while another member still links it, the source moves to them.
        yield* unlinkAccount(actors.owner, path, "service", account);
        yield* sourceRunsAs(actors.owner, account, ids.member);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const handed = yield* subscriptionRunsAs(actors.member, account, ids.member);
        expect(handed.id).toBe(first.id);
        yield* deliver(handed.callbackUrl, account);
        // The last unlink removes the source and stops its subscription; the account stays.
        yield* unlinkAccount(actors.member, path, "service", account);
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);
        yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.id === first.id && hook.status === "stopped"),
        );
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([]);
      }),
    ),
  );
  it.effect(scenarios.webhookSourceRelink.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connectShared, sourceRunsAs, subscriptionRunsAs, deliver } =
          yield* handoverFixture;
        const account = yield* connectShared(actors.member, { kind: "everyone" });
        yield* sourceRunsAs(actors.member, account, ids.member);
        const first = yield* subscriptionRunsAs(actors.member, account, ids.member);
        // Unlinking stops the subscription; its stopped row stays as history.
        yield* unlinkAccount(actors.member, path, "service", account);
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);
        yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((hook) => hook.id === first.id && hook.status === "stopped"),
        );
        // Linking the same account again registers a new subscription beside the stopped one.
        yield* linkAccount(actors.member, path, "service", account);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const relinked = yield* subscriptionRunsAs(actors.member, account, ids.member);
        expect(relinked.id).not.toBe(first.id);
        yield* deliver(relinked.callbackUrl, account);
        // The source moves to the owner and back to the member, who still has the stopped row.
        yield* linkAccount(actors.owner, path, "service", account);
        yield* unlinkAccount(actors.member, path, "service", account);
        yield* sourceRunsAs(actors.owner, account, ids.owner);
        expect((yield* subscriptionRunsAs(actors.owner, account, ids.owner)).id).toBe(relinked.id);
        yield* linkAccount(actors.member, path, "service", account);
        yield* unlinkAccount(actors.owner, path, "service", account);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const handedBack = yield* subscriptionRunsAs(actors.member, account, ids.member);
        expect(handedBack.id).toBe(relinked.id);
        yield* deliver(handedBack.callbackUrl, account);
        const hooks = yield* settleWebhookSubscriptions(actors.member, path, () => true);
        expect(
          hooks
            .filter((hook) => hook.sourceAccount === account)
            .map((hook) => [hook.id, hook.status])
            .sort(),
        ).toEqual(
          [
            [first.id, "stopped"],
            [relinked.id, "active"],
          ].sort(),
        );
      }),
    ),
  );
  it.effect(scenarios.webhookSourceGroupHandover.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          prefix,
          path,
          ids,
          connectShared,
          sourceRunsAs,
          subscriptionRunsAs,
          deliver,
        } = yield* handoverFixture;
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const memberOf = (userId: string) => {
          const found = directory.members.find((item) => item.userId === userId);
          if (found === undefined) throw new Error("Missing synthetic group member");
          return found.id;
        };
        const name = `Handover ${randomUUID().slice(0, 8)}`;
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name,
            description: "",
            memberIds: [memberOf(ids.member), memberOf(ids.admin)],
          }),
        );
        const shared: { account?: string } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // The registration ran as the member, who can no longer use the account, so removing
            // it waits for a person to confirm it was removed at the provider.
            if (shared.account !== undefined) {
              const account = shared.account;
              for (const actor of [actors.admin, actors.member])
                yield* api.request(
                  actor,
                  "DELETE",
                  `${requirementPath(path, "user", "service")}/${account}`,
                );
              const waiting = yield* settleWebhookSubscriptions(actors.admin, path, (hooks) =>
                hooks.every(
                  (hook) =>
                    hook.sourceAccount !== account ||
                    hook.status === "disabled" ||
                    hook.status === "stopped",
                ),
              );
              for (const hook of waiting)
                if (hook.sourceAccount === account && hook.status === "disabled")
                  yield* api.request(
                    actors.admin,
                    "POST",
                    `${path}/webhooks/${hook.id}/confirm-removal`,
                  );
              yield* removeAppWhenStopped(actors.owner, path);
            }
            const current = yield* body(
              Group,
              yield* api.request(actors.owner, "GET", `${prefix}/groups/${group.id}`),
            );
            yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
              revision: current.revision,
            });
          }).pipe(Effect.orDie),
        );
        // The member shares an account with the group, so the member runs its source.
        const account = yield* connectShared(actors.member, {
          kind: "groups",
          groups: [group.id],
        });
        shared.account = account;
        yield* linkAccount(actors.admin, path, "service", account);
        yield* sourceRunsAs(actors.admin, account, ids.member);
        const first = yield* subscriptionRunsAs(actors.admin, account, ids.member);
        yield* deliver(first.callbackUrl, account);
        // Leaving the group keeps the member's link but they can no longer use the account.
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/groups/${group.id}`, {
            name,
            description: "",
            memberIds: [memberOf(ids.admin)],
            revision: group.revision,
          })).status,
        ).toBe(200);
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        // The next delivery resolves the source's accounts and hands it to the admin, who links
        // the account and can still use it. That delivery never runs as the member who lost
        // access: it is refused as retryable, and the provider's redelivery runs as the admin.
        const refused = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(first.callbackUrl).pathname,
          {},
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(503);
        yield* sourceRunsAs(actors.admin, account, ids.admin);
        const handed = yield* subscriptionRunsAs(actors.admin, account, ids.admin);
        expect(handed.id).toBe(first.id);
        yield* deliver(handed.callbackUrl, account);
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([account]);
      }),
    ),
  );
  it.effect(scenarios.webhookSourceAppAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, ids, connectShared, sourceRunsAs, subscriptionRunsAs, deliver } =
          yield* handoverFixture;
        const audience = (kind: "everyone" | "private") =>
          Effect.gen(function* () {
            const access = yield* body(
              Schema.Struct({ revision: Schema.String }),
              yield* api.request(actors.owner, "GET", `${path}/access`),
            );
            const changed = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: access.revision,
              audience: { kind },
            });
            expect(changed.status, JSON.stringify(changed.body)).toBe(200);
          });
        // The member connects a shared account from the app, so the member runs its source.
        const account = yield* connectShared(actors.member, { kind: "everyone" });
        yield* sourceRunsAs(actors.member, account, ids.member);
        const hook = yield* subscriptionRunsAs(actors.member, account, ids.member);
        yield* deliver(hook.callbackUrl, account);
        // The app becomes private to its creator. The member still links a usable account, but
        // can no longer use the app, so a callback must not run its code as the member.
        yield* audience("private");
        const refused = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(hook.callbackUrl).pathname,
          {},
        );
        // Refused as retryable, like a source whose actor lost its account.
        expect(refused.status, JSON.stringify(refused.body)).toBe(503);
        expect(JSON.stringify(refused.body)).not.toContain("synthetic-handover");
        // Using the app again resumes delivery as the member.
        yield* audience("everyone");
        yield* deliver(hook.callbackUrl, account);
      }),
    ),
  );
  it.effect(scenarios.webhookSourceConcurrentLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connectShared, sourceRunsAs } = yield* handoverFixture;
        const account = yield* connectShared(actors.owner, { kind: "everyone" });
        yield* sourceRunsAs(actors.owner, account, ids.owner);
        // Each round, the only linking member unlinks while another member links, concurrently.
        // Whichever commits first, the account stays linked, so its source must stay.
        let linked = actors.owner,
          other = actors.member;
        for (let round = 0; round < 8; round++) {
          yield* Effect.all(
            [
              unlinkAccount(linked, path, "service", account),
              linkAccount(other, path, "service", account),
            ],
            {
              concurrency: 2,
            },
          );
          [linked, other] = [other, linked];
          expect(yield* linkedAccountIds(linked, path)).toEqual([account]);
          const sources = yield* webhookSources(linked, path);
          expect(
            sources.map((source) => source.account),
            `Round ${round} left the linked account without a source`,
          ).toEqual([account]);
        }
      }),
    ),
  );
  it.effect(scenarios.webhookSourceRemovalAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Unregistering needs the app's other account: it throws without one.
        const removal = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Removal source fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const other=defineProvider({name:"Removal other fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({}),state:object({}),
  register:async()=>({}),
  unregister:async ctx=>{if(ctx.user.accounts.other.fields.token!=="synthetic-other")throw new Error("other account missing");},
  handle:async ctx=>Response.json({account:ctx.user.accounts.service.id,other:ctx.user.accounts.other.id})};
export default defineApp({user: { accounts:{service,other} }},{tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Removal ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: removal }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        const removed: { status?: number } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (removed.status === undefined) yield* removeAppWhenStopped(actors.owner, path);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const connect = (requirement: "service" | "other", token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", connectionsPath(path, "user", requirement), {
                destination: { kind: "personal" },
              }),
            );
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label: `${requirement} account`, fields: { token } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            accounts.push(account);
            return account;
          });
        // The other account first, so the source registers as soon as its account is linked.
        const other = yield* connect("other", "synthetic-other");
        const service = yield* connect("service", "synthetic-service");
        const [hook] = yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((item) => item.sourceAccount === service && item.status === "active"),
        ).pipe(Effect.map((hooks) => hooks.filter((item) => item.sourceAccount === service)));
        if (hook === undefined) return yield* Effect.die(new Error("Webhook missing"));
        const delivered = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(hook.callbackUrl).pathname,
          {},
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        expect(delivered.body).toEqual({ account: service, other });
        // Unlinking both accounts leaves the owner no account for the other requirement. Removing
        // the registration still reaches the provider with the accounts it registered with.
        yield* unlinkAccount(actors.owner, path, "other", other);
        yield* unlinkAccount(actors.owner, path, "service", service);
        yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.some((item) => item.id === hook.id && item.status === "stopped"),
        );
        yield* settleWebhookSources(actors.owner, path, (sources) => sources.length === 0);
        removed.status = yield* removeAppWhenStopped(actors.owner, path);
        expect(removed.status).toBe(200);
      }),
    ),
  );
  it.effect(scenarios.webhookRegistrationActor.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // Unregistering needs the other account the registration ran with: the member's.
        const registration = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Registration source fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const other=defineProvider({name:"Registration other fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({}),state:object({}),
  register:async()=>({}),
  unregister:async ctx=>{if(ctx.user.accounts.other.fields.token!=="member-other")throw new Error("not the registration's account");},
  handle:async ctx=>Response.json({account:ctx.user.accounts.service.id,other:ctx.user.accounts.other.id})};
export default defineApp({user: { accounts:{service,other} }},{tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Registration ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: registration }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const [member, admin] = yield* Effect.forEach([actors.member, actors.admin], (actor) =>
          api.request(actor, "GET", "/api/viewer").pipe(
            Effect.flatMap((read) => body(Viewer, read)),
            Effect.map((viewer) => viewer.userId),
          ),
        );
        if (member === undefined || admin === undefined)
          return yield* Effect.die(new Error("Missing viewers"));
        const directory = yield* body(
          Directory,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const memberId = (userId: string) => {
          const found = directory.members.find((item) => item.userId === userId);
          if (found === undefined) throw new Error("Missing synthetic group member");
          return found.id;
        };
        const name = `Registration ${randomUUID().slice(0, 8)}`;
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name,
            description: "",
            memberIds: [memberId(member), memberId(admin)],
          }),
        );
        const owned: { actor: Session; requirement: string; account: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const actor of [actors.admin, actors.member])
              for (const item of owned)
                yield* api.request(
                  actor,
                  "DELETE",
                  `${requirementPath(path, "user", item.requirement)}/${item.account}`,
                );
            yield* removeAppWhenStopped(actors.owner, path);
            for (const item of owned)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.account}`);
            const current = yield* body(
              Group,
              yield* api.request(actors.owner, "GET", `${prefix}/groups/${group.id}`),
            );
            yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
              revision: current.revision,
            });
          }).pipe(Effect.orDie),
        );
        const connect = (
          actor: Session,
          requirement: "service" | "other",
          token: string,
          destination: unknown,
        ) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actor, "POST", connectionsPath(path, "user", requirement), {
                destination,
              }),
            );
            const saved = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label: token, fields: { token } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            owned.push({ actor, requirement, account });
            return account;
          });
        /** The source account's only live subscription, once `settled` accepts it. */
        const subscription = (
          account: string,
          settled: (hook: WebhookSubscriptionRow) => boolean,
        ) =>
          settleWebhookSubscriptions(actors.admin, path, (hooks) => {
            const live = hooks.filter(
              (hook) => hook.sourceAccount === account && hook.status !== "stopped",
            );
            return live.length === 1 && live[0] !== undefined && settled(live[0]);
          }).pipe(
            Effect.map((hooks) =>
              hooks.filter((hook) => hook.sourceAccount === account && hook.status !== "stopped"),
            ),
            Effect.flatMap(([hook]) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );
        const stopped = (id: string) =>
          settleWebhookSubscriptions(actors.admin, path, (hooks) =>
            hooks.some((hook) => hook.id === id && hook.status === "stopped"),
          );
        // Each member links a personal account for the other requirement; the member also shares
        // an account with the group, so the source registers as the member with their account.
        yield* connect(actors.member, "other", "member-other", { kind: "personal" });
        yield* connect(actors.admin, "other", "admin-other", { kind: "personal" });
        const shared = yield* connect(actors.member, "service", "shared-service", {
          kind: "shared",
          audience: { kind: "groups", groups: [group.id] },
        });
        yield* linkAccount(actors.admin, path, "service", shared);
        const first = yield* subscription(
          shared,
          (hook) => hook.actor === member && hook.status === "active",
        );

        // The member unlinks: the source moves to the admin, who cannot use the member's personal
        // account. Removing the registration still runs as the member, with their account.
        yield* unlinkAccount(actors.member, path, "service", shared);
        yield* subscription(shared, (hook) => hook.id === first.id && hook.actor === admin);
        yield* unlinkAccount(actors.admin, path, "service", shared);
        yield* stopped(first.id);
        yield* settleWebhookSources(actors.admin, path, (sources) =>
          sources.every((source) => source.account !== shared),
        );

        // Another shared account registers as the member and moves to the admin once the member
        // leaves the group. Removal cannot run as the member any more: the subscription waits,
        // disabled, until a person confirms it was removed at the provider.
        const second = yield* connect(actors.member, "service", "shared-service-2", {
          kind: "shared",
          audience: { kind: "groups", groups: [group.id] },
        });
        yield* linkAccount(actors.admin, path, "service", second);
        const registered = yield* subscription(
          second,
          (hook) => hook.actor === member && hook.status === "active",
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/groups/${group.id}`, {
            name,
            description: "",
            memberIds: [memberId(admin)],
            revision: group.revision,
          })).status,
        ).toBe(200);
        yield* unlinkAccount(actors.member, path, "service", second);
        yield* subscription(second, (hook) => hook.id === registered.id && hook.actor === admin);
        yield* unlinkAccount(actors.admin, path, "service", second);
        yield* subscription(
          second,
          (hook) =>
            hook.id === registered.id && hook.status === "disabled" && hook.failure === null,
        );
        const setup = yield* api.request(
          actors.admin,
          "GET",
          `${prefix}/webhook-setup/${app.id}/${registered.id}`,
        );
        expect(setup.status, JSON.stringify(setup.body)).toBe(200);
        expect(setup.body).toMatchObject({ step: "remove", subscription: { id: registered.id } });
        const confirmed = yield* api.request(
          actors.admin,
          "POST",
          `${path}/webhooks/${registered.id}/confirm-removal`,
        );
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
        expect(confirmed.body).toMatchObject({ id: registered.id, status: "stopped" });
        yield* settleWebhookSources(actors.admin, path, (sources) =>
          sources.every((source) => source.account !== second),
        );
      }),
    ),
  );
});
