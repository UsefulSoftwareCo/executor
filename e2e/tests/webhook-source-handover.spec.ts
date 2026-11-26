import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import {
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
  requirementPath,
  unlinkAccount,
  type LinkScope,
} from "../support/app-accounts.ts";
import {
  webhookSources,
  removeAppWhenStopped,
  settleWebhookSources,
  webhookSubscriptions,
  settleWebhookSubscriptions,
  type WebhookSourceRow,
  type WebhookSubscriptionRow,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Viewer = Schema.Struct({ userId: Schema.String });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const source = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Handover fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({}),state:object({}),
  register:async()=>({}),unregister:async()=>{},
  handle:async ctx=>Response.json({account:ctx.user.accounts.service.id,token:ctx.user.accounts.service.fields.token})};
export default defineApp({user: { accounts:{service} }},{tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`;
const bothScopes = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Handover fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const hook=(account)=>({account,config:object({}),state:object({}),
  register:async()=>({}),unregister:async()=>{},handle:async()=>Response.json({})});
export default defineApp({app:{accounts:{appService:service.many()}},user:{accounts:{service}}},{tools: router({
  identity:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming:hook({user:"service"}),appIncoming:hook({app:"appService"})}});`;

const handoverFixture = (content: string = source) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = yield* body(
      App,
      yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Handover ${randomUUID().slice(0, 8)}`,
        files: [{ path: "index.ts", content }, appsManifest],
      }),
    );
    const path = `${prefix}/apps/${app.id}`;
    const accounts: { actor: Session; id: string }[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const account of accounts) {
          yield* api.request(
            account.actor,
            "DELETE",
            `${requirementPath(path, "user", "service")}/${account.id}`,
          );
          if (content === bothScopes)
            yield* api.request(
              actors.owner,
              "DELETE",
              `${requirementPath(path, "app", "appService")}/${account.id}`,
            );
        }
        for (const account of accounts)
          yield* settleWebhookSubscriptions(account.actor, path, (hooks) =>
            hooks.every((hook) => hook.status === "stopped"),
          );
        yield* removeAppWhenStopped(actors.owner, path);
        for (const account of accounts)
          yield* api.request(account.actor, "DELETE", `${prefix}/accounts/${account.id}`);
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
    const connect = (actor: Session) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(actor, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const saved = yield* api.request(
          actor,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", label: "Handover account", fields: { token: "synthetic-handover" } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        accounts.push({ actor, id: account });
        return account;
      });
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
      connect,
      sourceRunsAs,
      subscriptionRunsAs,
      deliver,
    };
  });

layer(HostedLive, { excludeTestServices: true })("Webhook source handover", (it) => {
  it.effect(scenarios.webhookSourceRelink.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connect, sourceRunsAs, subscriptionRunsAs, deliver } =
          yield* handoverFixture();
        const account = yield* connect(actors.member);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const first = yield* subscriptionRunsAs(actors.member, account, ids.member);
        yield* unlinkAccount(actors.member, path, "service", account);
        yield* settleWebhookSources(actors.member, path, (sources) => sources.length === 0);
        yield* settleWebhookSubscriptions(actors.member, path, (hooks) =>
          hooks.some((hook) => hook.id === first.id && hook.status === "stopped"),
        );
        expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
        yield* linkAccount(actors.member, path, "service", account);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const relinked = yield* subscriptionRunsAs(actors.member, account, ids.member);
        expect(relinked.id).not.toBe(first.id);
        yield* deliver(relinked.callbackUrl, account);
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
  it.effect(scenarios.webhookSourceAppAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, ids, connect, sourceRunsAs, subscriptionRunsAs, deliver } =
          yield* handoverFixture();
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
        const account = yield* connect(actors.member);
        yield* sourceRunsAs(actors.member, account, ids.member);
        const hook = yield* subscriptionRunsAs(actors.member, account, ids.member);
        yield* deliver(hook.callbackUrl, account);
        yield* audience("private");
        const refused = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(hook.callbackUrl).pathname,
          {},
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(503);
        expect(JSON.stringify(refused.body)).not.toContain("synthetic-handover");
        yield* audience("everyone");
        yield* deliver(hook.callbackUrl, account);
      }),
    ),
  );
  it.effect(scenarios.webhookSourceConcurrentLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, ids, connect, sourceRunsAs } = yield* handoverFixture(bothScopes);
        const account = yield* connect(actors.owner);
        yield* sourceRunsAs(actors.owner, account, ids.owner);
        type Link = { readonly requirement: string; readonly scope: LinkScope };
        let linked: Link = { requirement: "service", scope: "user" },
          other: Link = { requirement: "appService", scope: "app" };
        for (let round = 0; round < 8; round++) {
          yield* Effect.all(
            [
              unlinkAccount(actors.owner, path, linked.requirement, account, linked.scope),
              linkAccount(actors.owner, path, other.requirement, account, other.scope),
            ],
            { concurrency: 2 },
          );
          [linked, other] = [other, linked];
          expect(yield* linkedAccountIds(actors.owner, path, linked.scope)).toEqual([account]);
          expect(yield* linkedAccountIds(actors.owner, path, other.scope)).toEqual([]);
          const sources = yield* webhookSources(actors.owner, path);
          expect(
            sources.map((source) => source.account),
            `Round ${round} left the linked account without a source`,
          ).toEqual([account]);
        }
        yield* settleWebhookSubscriptions(actors.owner, path, (hooks) =>
          hooks.every(
            (hook) =>
              (hook.actor === null) === (linked.scope === "app") || hook.status === "stopped",
          ),
        );
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
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", requirement),
                {},
              ),
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
        const member = (yield* body(
          Viewer,
          yield* api.request(actors.member, "GET", "/api/viewer"),
        )).userId;
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
          }).pipe(Effect.orDie),
        );
        const connect = (actor: Session, requirement: "service" | "other", token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actor, "POST", connectionsPath(path, "user", requirement), {}),
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
        const subscription = (
          account: string,
          settled: (hook: WebhookSubscriptionRow) => boolean,
        ) =>
          settleWebhookSubscriptions(actors.member, path, (hooks) => {
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
          settleWebhookSubscriptions(actors.member, path, (hooks) =>
            hooks.some((hook) => hook.id === id && hook.status === "stopped"),
          );
        yield* connect(actors.member, "other", "member-other");
        yield* connect(actors.admin, "other", "admin-other");
        const own = yield* connect(actors.member, "service", "member-service");
        const first = yield* subscription(
          own,
          (hook) => hook.actor === member && hook.status === "active",
        );
        expect((yield* linkAccountResponse(actors.admin, path, "service", own)).status).toBe(403);
        expect(
          (yield* webhookSubscriptions(actors.admin, path)).some((hook) => hook.id === first.id),
        ).toBe(false);

        yield* unlinkAccount(actors.member, path, "service", own);
        yield* stopped(first.id);
        yield* settleWebhookSources(actors.member, path, (sources) =>
          sources.every((source) => source.account !== own),
        );

        const second = yield* connect(actors.member, "service", "member-service-2");
        const registered = yield* subscription(
          second,
          (hook) => hook.actor === member && hook.status === "active",
        );
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.member, "GET", "/api/auth/get-session"),
        );
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: user.email,
          })).status,
        ).toBe(200);
        const refused = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(registered.callbackUrl).pathname,
          {},
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(503);
        const confirmed = yield* api
          .request(actors.admin, "POST", `${path}/webhooks/${registered.id}/confirm-removal`)
          .pipe(
            Effect.repeat({
              until: (response) => response.status !== 409,
              schedule: Schedule.spaced("250 millis"),
              times: 120,
            }),
          );
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
        expect(confirmed.body).toMatchObject({ id: registered.id, status: "stopped" });
      }),
    ),
  );
});
