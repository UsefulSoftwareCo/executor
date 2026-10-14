/** A linked account's webhook source registers silently; failures and configuration live in Webhooks. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import {
  accountLinks,
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  requirementPath,
} from "../support/app-accounts.ts";
import { webhookRegistrationFixture } from "../support/webhook-registration.ts";
import {
  removeAppWhenStopped,
  settleWebhookSources,
  sourcesAre,
  webhookSources,
  webhookSubscriptions,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Viewer = Schema.Struct({ userId: Schema.String });

/** An app whose webhook registers through `register`, keeping the configured channel as state. */
const webhookApp = (name: string, register: string) => ({
  name,
  files: [
    {
      path: "index.ts",
      content: `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Webhook source fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({channel:string().optional()}),state:object({channel:string()}),
  register:async(ctx,{config})=>{${register}return {channel:config.channel??"default"};},
  unregister:async()=>{},
  handle:async(ctx,{state})=>Response.json({channel:state?.channel??null,account:ctx.user.accounts.service.id})};
export default defineApp({user: { accounts:{service} }},{tools: router({
  ready:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`,
    },
    appsManifest,
  ],
});

/** Connect an account from the app, which links it for the connecting member. */
const connect = (
  actor: Session,
  prefix: string,
  appPath: string,
  label: string,
  destination?: unknown,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const connection = yield* body(
      Resource,
      yield* api.request(
        actor,
        "POST",
        connectionsPath(appPath, "user", "service"),
        destination === undefined ? {} : { destination },
      ),
    );
    const saved = yield* api.request(
      actor,
      "POST",
      `${prefix}/connections/${connection.id}/submit`,
      {
        method: "key",
        label,
        fields: { token: "synthetic" },
      },
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return (yield* body(Resource, saved)).id;
  });

layer(HostedLive, { excludeTestServices: true })("Webhook source status", (it) => {
  it.effect(scenarios.webhookSourceStatus.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          provider = yield* webhookRegistrationFixture;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/deploy`,
          webhookApp(
            `Setup status ${randomUUID().slice(0, 6)}`,
            `const response=await ctx.fetch(${JSON.stringify(provider.url)},{method:"POST"});if(!response.ok)throw new Error("Registration failed");`,
          ),
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const created: { account?: string } = {};
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* provider.recover;
            yield* provider.fail;
            if (created.account !== undefined) {
              yield* api.request(
                actors.owner,
                "DELETE",
                `${requirementPath(path, "user", "service")}/${created.account}`,
              );
            }
            yield* removeAppWhenStopped(actors.owner, path);
            if (created.account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
          }).pipe(Effect.orDie),
        );
        const account = yield* connect(actors.owner, prefix, path, "My account");
        created.account = account;
        // Connecting from the app links the account, which becomes the app's webhook source.
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const owner = yield* body(Viewer, yield* api.request(actors.owner, "GET", "/api/viewer"));
        yield* browser.login(actors.owner);
        yield* browser.use("Open tools while registration is pending", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`),
        );
        yield* provider.requested;
        yield* browser.use("Tools remain usable during setup", (page) =>
          page.getByRole("button", { name: "ready", exact: true }).waitFor(),
        );
        const pending = yield* webhookSources(actors.owner, path);
        expect(pending).toMatchObject([
          { account, actor: owner.userId, label: "My account", status: "pending", failure: null },
        ]);
        yield* browser.use("Open webhooks while registration is pending", (page) =>
          page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("link", { name: "Webhooks", exact: true })
            .click(),
        );
        yield* browser.use("The source's configuration editor is listed", (page) =>
          page
            .locator("summary")
            .filter({ hasText: "Webhook configuration for My account" })
            .waitFor(),
        );
        expect(
          yield* browser.use("No failure appears while registration is pending", (page) =>
            page.getByRole("alert").filter({ hasText: "Registration failed." }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("No retry control appears before a failure", (page) =>
            page.getByRole("button", { name: "Retry webhook", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Pending provider registration stays invisible");
        yield* provider.fail;
        yield* browser.use("The provider failure is shown", (page) =>
          page.getByRole("alert").filter({ hasText: "Registration failed." }).waitFor(),
        );
        yield* browser.use("Retry is available after failure", (page) =>
          page.getByRole("button", { name: "Retry webhook", exact: true }).waitFor(),
        );
        yield* settleWebhookSources(
          actors.owner,
          path,
          sourcesAre({ [account]: { status: "failed", failure: "registration" } }),
        );
        yield* browser.checkpoint("Registration failure is shown in Webhooks");
        yield* provider.recover;
        yield* browser.use("Retry after provider recovery", (page) =>
          page.getByRole("button", { name: "Retry webhook", exact: true }).click(),
        );
        yield* browser.use("The error disappears after successful registration", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "Registration failed." })
            .waitFor({ state: "hidden" }),
        );
        yield* browser.use("Successful registration has no retry control", (page) =>
          page.getByRole("button", { name: "Retry webhook", exact: true }).waitFor({
            state: "hidden",
          }),
        );
        const first = (yield* webhookSubscriptions(actors.owner, path)).filter(
          (hook) => hook.status === "active",
        );
        expect(first).toMatchObject([
          { name: "incoming", sourceAccount: account, actor: owner.userId },
        ]);
        // Saving the source's configuration registers its subscription again with it.
        yield* browser.use("Open the source configuration", (page) =>
          page
            .locator("summary")
            .filter({ hasText: "Webhook configuration for My account" })
            .click(),
        );
        yield* browser.use("Edit the source configuration", (page) =>
          page
            .getByRole("textbox", { name: "Webhook configuration for My account", exact: true })
            .fill('{"incoming":{"channel":"saved"}}'),
        );
        yield* browser.use("Save the source configuration", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith(`/webhook-sources/${account}/config`) &&
                response.request().method() === "PUT" &&
                response.status() === 200,
            ),
            page.getByRole("button", { name: "Save webhook configuration", exact: true }).click(),
          ]),
        );
        const ready = yield* settleWebhookSources(
          actors.owner,
          path,
          sourcesAre({ [account]: { status: "ready", failure: null } }),
        );
        expect(ready[0]?.config).toEqual({ incoming: { channel: "saved" } });
        const hooks = yield* webhookSubscriptions(actors.owner, path);
        const active = hooks.filter((hook) => hook.status === "active");
        expect(active).toHaveLength(1);
        const current = active[0];
        if (current === undefined) return yield* Effect.die(new Error("Webhook missing"));
        expect(current.id).not.toBe(first[0]?.id);
        expect(hooks.find((hook) => hook.id === first[0]?.id)?.status).toBe("stopped");
        const delivered = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(current.callbackUrl).pathname,
          {},
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        expect(delivered.body).toEqual({ channel: "saved", account });
        expect(
          yield* browser.use("The saved configuration has no failure", (page) =>
            page.getByRole("alert").filter({ hasText: "Registration failed." }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Saved configuration re-registers the source");
      }),
    ),
  );
  it.effect(scenarios.webhookSourceEditors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          App,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/deploy`,
            webhookApp(`Source editors ${randomUUID().slice(0, 6)}`, ""),
          ),
        );
        const path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const actor of [actors.owner, actors.member])
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
        const everyone = { kind: "shared", audience: { kind: "everyone" } };
        const ownerAccount = yield* connect(actors.owner, prefix, path, "Owner shared", everyone);
        accounts.push(ownerAccount);
        // The member also links the owner's account, but its source keeps running as the owner.
        yield* linkAccount(actors.member, path, "service", ownerAccount);
        const memberAccount = yield* connect(
          actors.member,
          prefix,
          path,
          "Member shared",
          everyone,
        );
        accounts.push(memberAccount);
        const [owner, member] = yield* Effect.forEach([actors.owner, actors.member], (actor) =>
          api
            .request(actor, "GET", "/api/viewer")
            .pipe(Effect.flatMap((read) => body(Viewer, read))),
        );
        if (owner === undefined || member === undefined)
          return yield* Effect.die(new Error("Missing viewers"));
        const ready = { status: "ready", failure: null };
        const all = yield* settleWebhookSources(
          actors.owner,
          path,
          sourcesAre({ [ownerAccount]: ready, [memberAccount]: ready }),
        );
        expect(Object.fromEntries(all.map((source) => [source.account, source.actor]))).toEqual({
          [ownerAccount]: owner.userId,
          [memberAccount]: member.userId,
        });
        // A member who is neither the source's actor nor an app manager cannot see or change it.
        expect(
          (yield* webhookSources(actors.member, path)).map((source) => source.account),
        ).toEqual([memberAccount]);
        const forbidden = yield* api.request(
          actors.member,
          "PUT",
          `${path}/webhook-sources/${ownerAccount}/config`,
          { config: { incoming: { channel: "member" } } },
        );
        expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);
        // An app manager sees and changes every source whose account they can use.
        expect(
          (yield* webhookSources(actors.admin, path)).map((source) => source.account).sort(),
        ).toEqual([ownerAccount, memberAccount].sort());
        const managed = yield* api.request(
          actors.admin,
          "PUT",
          `${path}/webhook-sources/${memberAccount}/config`,
          { config: { incoming: { channel: "admin" } } },
        );
        expect(managed.status, JSON.stringify(managed.body)).toBe(200);
        expect(managed.body).toMatchObject({
          account: memberAccount,
          actor: member.userId,
          config: { incoming: { channel: "admin" } },
        });
        yield* browser.login(actors.member);
        yield* browser.use("Member opens webhooks", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=webhooks`),
        );
        yield* browser.use("Member sees the source they run", (page) =>
          page
            .locator("summary")
            .filter({ hasText: "Webhook configuration for Member shared" })
            .click(),
        );
        expect(
          yield* browser.use("Member does not see the owner's source", (page) =>
            page
              .locator("summary")
              .filter({ hasText: "Webhook configuration for Owner shared" })
              .count(),
          ),
        ).toBe(0);
        yield* browser.use("Member edits their source configuration", (page) =>
          page
            .getByRole("textbox", { name: "Webhook configuration for Member shared", exact: true })
            .fill('{"incoming":{"channel":"member"}}'),
        );
        yield* browser.use("Member saves their source configuration", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith(`/webhook-sources/${memberAccount}/config`) &&
                response.request().method() === "PUT" &&
                response.status() === 200,
            ),
            page.getByRole("button", { name: "Save webhook configuration", exact: true }).click(),
          ]),
        );
        yield* browser.checkpoint("A source's actor configures it without managing the app");
        yield* browser.login(actors.admin);
        yield* browser.use("Admin opens webhooks", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=webhooks`),
        );
        for (const label of ["Owner shared", "Member shared"])
          yield* browser.use(`Admin sees the ${label} source`, (page) =>
            page
              .locator("summary")
              .filter({ hasText: `Webhook configuration for ${label}` })
              .waitFor(),
          );
        yield* browser.checkpoint("An app manager sees every source");
        const configured = yield* settleWebhookSources(
          actors.owner,
          path,
          sourcesAre({ [ownerAccount]: ready, [memberAccount]: ready }),
        );
        expect(configured.find((source) => source.account === memberAccount)?.config).toEqual({
          incoming: { channel: "member" },
        });
      }),
    ),
  );
  it.effect(scenarios.webhookSourceAccountChoice.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const source = `import {defineApp,defineProvider,secrets,query,object,string,router} from "apps";
const service=defineProvider({name:"Choice source fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const other=defineProvider({name:"Choice other fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
const incoming={account:{ user: "service" },config:object({}),state:object({}),
  register:async()=>({}),unregister:async()=>{},
  handle:async ctx=>Response.json({account:ctx.user.accounts.service.id,other:ctx.user.accounts.other.id})};
export default defineApp({user: { accounts:{service,other} }},{tools: router({
  ready:query({input:object({})},async ctx=>ctx.user.accounts.service.id),
}),webhooks:{incoming}});`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Source choice ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const accounts: { requirement: string; account: string }[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const { requirement, account } of accounts)
              yield* api.request(
                actors.member,
                "DELETE",
                `${requirementPath(path, "user", requirement)}/${account}`,
              );
            yield* removeAppWhenStopped(actors.owner, path);
            for (const { account } of accounts)
              yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${account}`);
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
        const connectFor = (requirement: "service" | "other", label: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.member,
                "POST",
                connectionsPath(path, "user", requirement),
                {
                  destination: { kind: "personal" },
                },
              ),
            );
            const saved = yield* api.request(
              actors.member,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token: "synthetic" } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            accounts.push({ requirement, account });
            return account;
          });
        const work = yield* connectFor("other", "Work other");
        const home = yield* connectFor("other", "Home other");
        // The other requirement is plain, so connecting Home for it replaces Work.
        expect(yield* accountLinks(actors.member, path)).toEqual([["other", home]]);
        const service = yield* connectFor("service", "Member service");
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["other", home],
          ["service", service],
        ]);
        // The source registers with the actor's link for the other requirement; nothing is chosen.
        const [ready] = yield* settleWebhookSources(actors.member, path, (sources) =>
          sources.some((item) => item.account === service && item.status === "ready"),
        ).pipe(Effect.map((sources) => sources.filter((item) => item.account === service)));
        expect(ready).toBeDefined();
        const listed = yield* api.request(actors.member, "GET", `${path}/webhook-sources`);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        // Every linked account is a source of the app; none carries account choices.
        expect(
          (listed.body as ReadonlyArray<Record<string, unknown>>)
            .map((item) => ({
              account: item["account"],
              accounts: Object.hasOwn(item, "accounts"),
            }))
            .sort((a, b) => String(a.account).localeCompare(String(b.account))),
          JSON.stringify(listed.body),
        ).toEqual(
          [home, service]
            .sort((a, b) => a.localeCompare(b))
            .map((account) => ({ account, accounts: false })),
        );
        // Deliver to the source's current active registration.
        const deliver = Effect.gen(function* () {
          const hook = (yield* webhookSubscriptions(actors.member, path)).find(
            (item) => item.sourceAccount === service && item.status === "active",
          );
          if (hook === undefined) return yield* Effect.die(new Error("Webhook missing"));
          const delivered = yield* api.request(
            yield* api.session(),
            "POST",
            new URL(hook.callbackUrl).pathname,
            {},
          );
          expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
          return delivered.body;
        });
        expect(yield* deliver).toEqual({ account: service, other: home });
        // A saved choice is no longer accepted: an `accounts` field is not saved, and deliveries
        // keep following the actor's link.
        const saved = yield* api.request(
          actors.member,
          "PUT",
          `${path}/webhook-sources/${service}/config`,
          { config: {}, accounts: { other: [work] } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(Object.hasOwn(saved.body as Record<string, unknown>, "accounts")).toBe(false);
        yield* settleWebhookSources(actors.member, path, (sources) =>
          sources.some((item) => item.account === service && item.status === "ready"),
        );
        expect(yield* deliver).toEqual({ account: service, other: home });
        yield* browser.login(actors.member);
        yield* browser.use("Member opens webhooks", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=webhooks`),
        );
        yield* browser.use("The member's source is listed", (page) =>
          page
            .locator("summary")
            .filter({ hasText: "Webhook configuration for Member service" })
            .waitFor(),
        );
        expect(
          yield* browser.use("No account choice is offered for the source", (page) =>
            page
              .getByRole("combobox", {
                name: "Choice other fixture (other) account for Member service",
                exact: true,
              })
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("A webhook source without an account choice");
        // Linking Work replaces Home for the other requirement; the next delivery uses Work while
        // the source keeps its own account.
        yield* linkAccount(actors.member, path, "other", work);
        expect(yield* accountLinks(actors.member, path)).toEqual([
          ["other", work],
          ["service", service],
        ]);
        expect(yield* deliver).toEqual({ account: service, other: work });
      }),
    ),
  );
});
