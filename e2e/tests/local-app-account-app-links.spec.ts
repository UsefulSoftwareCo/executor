/**
 * Local app accounts: the owner links saved accounts to an app's own requirements, and every call,
 * the app schedule, the app-account webhook and MCP use the app's linked account without a link of
 * the caller's.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import {
  connectAccountsThroughOtherApp,
  connectLocalAccount,
  linkAccountResponse,
  requirementPath,
} from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import {
  callLocalQuery,
  linkLocal,
  localAccountLinks,
  localAgent,
  localAppPath,
  localLinks,
  unlinkLocal,
} from "../support/local-links.ts";
import { McpClient } from "../support/mcp-client.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import {
  ConnectionView,
  consentTo,
  revokeClientGrants,
  TargetRefusal,
  targetRefusal,
} from "../support/mcp-connections.ts";
import { holdTools, untilHeld } from "../support/held-call.ts";
import { Target } from "../support/platform.ts";
import {
  settleWebhookSources,
  settleWebhookSubscriptions,
  sourcesAre,
  type WebhookSourceRow,
} from "../support/webhook-sources.ts";
import {
  userWebhookRequirements,
  userWebhookRequirementsSource,
} from "../support/user-webhook-requirements.ts";
import { scenarios } from "../test-plan.ts";

type Files = ReadonlyArray<{ readonly path: string; readonly content: string }>;

/** A keyed provider whose accounts carry a synthetic token. */
const keyedProvider = (name: string) =>
  `defineProvider({ name: ${JSON.stringify(name)}, auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } })`;
const serviceProvider = keyedProvider("App service fixture");
const mailProvider = keyedProvider("Linked mail fixture");

const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Unknown });
const AccountRequired = Schema.Struct({
  _tag: Schema.Literal("AccountRequired"),
  slot: Schema.String,
  scope: Schema.String,
});
const RequirementMismatch = Schema.Struct({
  _tag: Schema.Literal("RequirementMismatch"),
  app: Schema.String,
  requirement: Schema.String,
  scope: Schema.Literals(["app", "user"]),
  reason: Schema.Literals(["requirement", "provider"]),
});
const AccountLinkedToApp = Schema.Struct({
  _tag: Schema.Literal("AccountLinkedToApp"),
  account: Schema.String,
  apps: Schema.Array(Schema.String),
});
/** One requirement as `GET /accounts/{app|user}/:requirement` returns it. */
const Requirement = Schema.Struct({
  requirement: Schema.String,
  scope: Schema.Literals(["app", "user"]),
  provider: Schema.String,
  cardinality: Schema.Literals(["one", "many"]),
  accounts: Schema.Array(
    Schema.Struct({
      account: Schema.Struct({ id: Schema.String, provider: Schema.String }),
      linked: Schema.Boolean,
    }),
  ),
});
const SavedAccount = Schema.Struct({ id: Schema.String, provider: Schema.String });
const Settings = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  actor: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  accountRequired: Schema.optional(Schema.String),
});
const Runs = Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String }));

/**
 * Deploy an app as the local agent. The finalizer removes the app, then the accounts the case
 * saved through the dashboard route, which refuses an account that is still linked to an app.
 */
const deployLocal = (name: string, files: Files) =>
  Effect.gen(function* () {
    const { api, agent, target } = yield* localAgent;
    const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
      owner: "local",
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const { app } = yield* body(Schema.Struct({ app: App }), deployed);
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
        for (const account of accounts)
          yield* api.request(agent, "DELETE", `/dashboard/api/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    /** Save keyed service accounts linked to no app, through a throwaway app. */
    const saveServiceAccounts = (...tokens: string[]) =>
      Effect.gen(function* () {
        const saved = yield* connectAccountsThroughOtherApp(agent, {
          provider: serviceProvider,
          method: "key",
          accounts: tokens.map((token) => ({ label: token, fields: { token } })),
        });
        accounts.push(...saved.map((account) => account.id));
        return saved.map((account) => account.id);
      });
    /** Connect an account from this app for `requirement`. */
    const connect = (requirement: string, token: string) =>
      Effect.gen(function* () {
        const { id } = yield* connectLocalAccount(agent, {
          app: app.id,
          requirement,
          method: "key",
          label: token,
          fields: { token },
        });
        accounts.push(id);
        return id;
      });
    /** Delete `account` with the case's other accounts. */
    const track = (account: string) => {
      accounts.push(account);
    };
    return { api, agent, target, app, saveServiceAccounts, connect, track };
  });

/** Call a local tool through the SDK route, returning the raw response. */
const callTool = (agent: Session, app: string, tool: string, kind: "query" | "mutation") =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.request(agent, "POST", "/v1/tools/call", { app, tool, kind, input: {} });
  });

/** An app with an app requirement and a user requirement, whose `who` names both accounts. */
const appLinkFiles: Files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, query, object, router, secrets, string } from "apps";
const service = ${serviceProvider};
const mail = ${mailProvider};
const requirements = { app: { accounts: { svc: service } }, user: { accounts: { mine: mail } } };
export default defineApp(requirements, async () => ({
  tools: router({
    who: query({ input: object({}) }, async (ctx) => ({ app: ctx.app.accounts.svc.id, user: ctx.user.accounts.mine.id })),
  }),
}));`,
  },
  appsManifest,
];

/** An app whose app schedule records the linked app account and whether its context had a user. */
const scheduleFiles: Files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, secrets, query, mutation, appInterval, object, string, router,
  type MutationContext, type QueryContext } from "apps";
const service = ${serviceProvider};
const requirements = { app: { accounts: { svc: service } } };
const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements, "app">) => {
  ctx.sql.exec("INSERT INTO ticks (account, has_user) VALUES (?, ?)", ctx.app.accounts.svc.id, "user" in ctx ? 1 : 0);
  return ctx.app.accounts.svc.id;
});
const ticks = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec<{ account: string; has_user: number }>("SELECT account, has_user FROM ticks ORDER BY seq").toArray()
    .map((row) => [row.account, row.has_user === 1]));
export default defineApp(requirements, async () => ({
  tools: router({ tick, ticks }),
  schedules: { tick: appInterval({ minutes: 1 }, tick, {}) },
}));`,
  },
  {
    path: "migrations/0001_ticks.sql",
    content:
      "CREATE TABLE ticks (seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, has_user INTEGER NOT NULL);\n",
  },
  appsManifest,
];

/**
 * An app whose webhook's source is its app-linked `svc` account. A user requirement shares the
 * provider, so the same accounts can also be linked for the local user.
 */
const webhookFiles: Files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, query, object, router, secrets, string } from "apps";
const service = ${serviceProvider};
const requirements = { app: { accounts: { svc: service } }, user: { accounts: { mine: service } } };
const incoming = {
  account: { app: "svc" },
  config: object({}),
  state: object({}),
  register: async () => ({}),
  unregister: async () => {},
  handle: async (ctx, { account }) => Response.json({ hasUser: "user" in ctx, account: ctx.app.accounts.svc.id, source: account.id }),
};
export default defineApp(requirements, {
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  webhooks: { incoming },
});`,
  },
  appsManifest,
];

layer(TestLive, { excludeTestServices: true })("Local app account app links", (it) => {
  it.effect(scenarios.localAppAccountAppLinks.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent, app, saveServiceAccounts, connect, track } = yield* deployLocal(
          "App links",
          appLinkFiles,
        );
        const who = Effect.gen(function* () {
          const response = yield* callTool(agent, app.id, "who", "query");
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return (yield* body(
            Schema.Struct({ value: Schema.Struct({ app: Schema.String, user: Schema.String }) }),
            response,
          )).value;
        });
        const required = Effect.gen(function* () {
          const response = yield* callTool(agent, app.id, "who", "query");
          expect(response.status, JSON.stringify(response.body)).toBe(409);
          expect(yield* body(AccountRequired, response)).toMatchObject({
            slot: "svc",
            scope: "app",
          });
          return response.body;
        });
        const saved = (account: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(agent, "GET", `/v1/accounts/${account}`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
          });
        const requirement = (scope: "app" | "user", name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              agent,
              "GET",
              requirementPath(localAppPath(app.id), scope, name),
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Requirement, response);
          });

        // Connecting the user requirement links it for the local user, not as the app's account.
        const mine = yield* connect("mine", "synthetic-mine");
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", mine]]);
        const [first, second] = yield* saveServiceAccounts("synthetic-first", "synthetic-second");
        if (first === undefined || second === undefined)
          return yield* Effect.die("Account fixtures missing");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([]);
        // Before one is linked, the call names the app requirement and who must link it.
        expect(yield* required).toMatchObject({
          message:
            "This app needs its own “svc” account, which someone who can edit the app links for everyone who uses it. None is linked yet.",
          recovery: {
            action: "Ask someone who can edit this app to link an account on its Accounts tab.",
          },
        });
        const svc = (yield* requirement("app", "svc")).accounts;
        const unlinked = svc.filter((entry) => !entry.linked).map((entry) => entry.account.id);
        expect(svc.filter((entry) => entry.linked)).toEqual([]);
        expect(unlinked).toEqual(expect.arrayContaining([first, second]));
        expect(unlinked).not.toContain(mine);

        // Linking fills the app requirement for every call.
        yield* linkLocal(agent, app.id, "svc", first, "app");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", first]]);
        expect(yield* who).toEqual({ app: first, user: mine });
        // The requirement lists its linked account first, then the owner's other accounts of its
        // provider, which could be linked; the user requirement's account of another provider is
        // never offered.
        const linkedFirst = yield* requirement("app", "svc");
        expect(linkedFirst).toMatchObject({ requirement: "svc", scope: "app", cardinality: "one" });
        expect(linkedFirst.accounts[0]).toMatchObject({ account: { id: first }, linked: true });
        expect(linkedFirst.accounts.slice(1).every((entry) => !entry.linked)).toBe(true);
        expect(linkedFirst.accounts.map((entry) => entry.account.id)).toContain(second);
        expect(linkedFirst.accounts.slice(1).map((entry) => entry.account.id)).toEqual(
          expect.arrayContaining([second]),
        );
        expect(linkedFirst.accounts.map((entry) => entry.account.id)).not.toContain(mine);
        expect(
          linkedFirst.accounts.every((entry) => entry.account.provider === linkedFirst.provider),
        ).toBe(true);
        // Linking another account to the plain requirement replaces it; the first stays saved.
        yield* linkLocal(agent, app.id, "svc", second, "app");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", second]]);
        expect(yield* who).toEqual({ app: second, user: mine });
        yield* saved(first);
        const linkedSecond = yield* requirement("app", "svc");
        expect(linkedSecond.accounts[0]).toMatchObject({ account: { id: second }, linked: true });
        expect(linkedSecond.accounts.filter((entry) => entry.linked)).toHaveLength(1);
        expect(linkedSecond.accounts).toContainEqual(
          expect.objectContaining({
            account: expect.objectContaining({ id: first }),
            linked: false,
          }),
        );
        // Unlinking leaves the requirement empty and keeps the account; linking again restores it.
        yield* unlinkLocal(agent, app.id, "svc", second, "app");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([]);
        yield* required;
        yield* saved(second);
        yield* linkLocal(agent, app.id, "svc", second, "app");
        expect(yield* who).toEqual({ app: second, user: mine });
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", mine]]);

        // A link must name a requirement of its own scope and an account of its provider.
        for (const [scope, name, account, reason] of [
          ["app", "mine", first, "requirement"],
          ["app", "missing", first, "requirement"],
          ["user", "svc", first, "requirement"],
          ["app", "svc", mine, "provider"],
          ["user", "mine", first, "provider"],
        ] as const) {
          const refused = yield* linkAccountResponse(
            agent,
            localAppPath(app.id),
            name,
            account,
            scope,
          );
          expect(refused.status, JSON.stringify(refused.body)).toBe(422);
          expect(yield* body(RequirementMismatch, refused)).toMatchObject({
            app: app.id,
            requirement: name,
            scope,
            reason,
          });
        }
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", second]]);
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", mine]]);

        // An account linked to an app for everyone cannot be deleted until it is unlinked.
        const blocked = yield* api.request(agent, "DELETE", `/dashboard/api/accounts/${second}`);
        expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
        expect(yield* body(AccountLinkedToApp, blocked)).toMatchObject({
          account: second,
          apps: [app.id],
        });
        yield* saved(second);
        yield* unlinkLocal(agent, app.id, "svc", second, "app");
        const removed = yield* api.request(agent, "DELETE", `/dashboard/api/accounts/${second}`);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);

        // Connecting an account for the app requirement links it for everyone, not for the user.
        const connected = yield* connect("svc", "synthetic-connected");
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", connected]]);
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", mine]]);
        expect(yield* who).toEqual({ app: connected, user: mine });

        // The dashboard's connection for the app requirement saves the account and links it in
        // place of the earlier one, which stays saved.
        const created = yield* api.request(
          agent,
          "POST",
          `${requirementPath(localAppPath(app.id), "app", "svc")}/connections`,
          { method: "key", label: "synthetic-dashboard", fields: { token: "synthetic-dashboard" } },
        );
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const dashboard = (yield* body(SavedAccount, created)).id;
        track(dashboard);
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", dashboard]]);
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", mine]]);
        expect(yield* who).toEqual({ app: dashboard, user: mine });
        yield* saved(connected);

        // Deleting an account linked only for the user removes its link.
        const deleted = yield* api.request(agent, "DELETE", `/dashboard/api/accounts/${mine}`);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(yield* localLinks(agent, app.id)).toEqual([]);
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", dashboard]]);
      }),
    ),
  );

  it.effect(scenarios.localAppAccountScopesUnique.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent } = yield* localAgent;
        const refused = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Both scopes ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, query, object, router, secrets, string } from "apps";
const service = ${serviceProvider};
const mail = ${mailProvider};
export default defineApp({ app: { accounts: { x: service } }, user: { accounts: { x: mail } } }, async () => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(refused.status, JSON.stringify(refused.body)).not.toBe(200);
        expect(JSON.stringify(refused.body)).toContain(
          "declared as both an app and a user account",
        );
        const listed = yield* api.request(agent, "GET", "/v1/apps?owner=local");
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(JSON.stringify(listed.body)).not.toContain("Both scopes");
      }),
    ),
  );

  it.effect(scenarios.localAppScheduleAppLinks.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent, app, saveServiceAccounts } = yield* deployLocal(
          "App schedule",
          scheduleFiles,
        );
        const path = `/dashboard/api/apps/${app.id}/schedules`;
        const settings = api
          .request(agent, "GET", path)
          .pipe(Effect.flatMap((response) => body(Schema.Array(Settings), response)));
        const runs = api
          .request(agent, "GET", `/dashboard/api/scheduled-runs?app=${app.id}`)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const succeeded = (count: number) =>
          runs.pipe(
            Effect.flatMap((rows) =>
              rows.filter((row) => row.name === "tick" && row.status === "succeeded").length >=
              count
                ? Effect.void
                : Effect.fail(
                    new Error(`tick has not run ${count} times: ${JSON.stringify(rows)}`),
                  ),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
        const [first, second] = yield* saveServiceAccounts("synthetic-first", "synthetic-second");
        if (first === undefined || second === undefined)
          return yield* Effect.die("Account fixtures missing");
        yield* linkLocal(agent, app.id, "svc", first, "app");

        // The app schedule has no actor and starts paused until the owner enables it.
        const enabled = yield* api.request(agent, "PATCH", `${path}/tick`, {
          enabled: true,
          scope: "app",
        });
        expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
        const schedule = yield* body(Settings, enabled);
        expect(schedule).toMatchObject({ name: "tick", actor: null, enabled: true });
        expect(yield* settings).toMatchObject([{ id: schedule.id, actor: null, enabled: true }]);
        expect((yield* settings)[0]?.accountRequired).toBeUndefined();
        const runNow = api.request(agent, "POST", `${path}/tick/copies/${schedule.id}/run`);

        // A run uses the app's linked account and runs without a caller.
        const started = yield* runNow;
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        yield* succeeded(1);
        expect(yield* callLocalQuery(agent, app.id, "ticks")).toEqual([[first, false]]);

        // Without an app link the schedule waits for one and a run is refused.
        yield* unlinkLocal(agent, app.id, "svc", first, "app");
        expect(yield* settings).toMatchObject([
          { id: schedule.id, actor: null, enabled: true, accountRequired: "svc" },
        ]);
        const refused = yield* runNow;
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(yield* body(AccountRequired, refused)).toMatchObject({ slot: "svc", scope: "app" });

        // Linking another account resumes it with that account.
        yield* linkLocal(agent, app.id, "svc", second, "app");
        expect((yield* settings)[0]?.accountRequired).toBeUndefined();
        const again = yield* runNow;
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        yield* succeeded(2);
        expect(yield* callLocalQuery(agent, app.id, "ticks")).toEqual([
          [first, false],
          [second, false],
        ]);
        expect((yield* runs).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
      }),
    ),
  );

  it.effect(scenarios.localAppAccountWebhook.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent, app, saveServiceAccounts } = yield* deployLocal(
          "App webhook",
          webhookFiles,
        );
        const appPath = localAppPath(app.id);
        const [shared, personal] = yield* saveServiceAccounts(
          "synthetic-shared",
          "synthetic-personal",
        );
        if (shared === undefined || personal === undefined)
          return yield* Effect.die("Account fixtures missing");
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const account of [shared, personal]) {
              yield* api.request(agent, "DELETE", `${appPath}/accounts/app/svc/${account}`);
              yield* api.request(agent, "DELETE", `${appPath}/accounts/user/mine/${account}`);
            }
          }).pipe(Effect.orDie),
        );
        const ready =
          (account: string, actor: string | null) => (rows: readonly WebhookSourceRow[]) =>
            rows.some(
              (row) => row.account === account && row.actor === actor && row.status === "ready",
            );

        // Linking for everyone makes the account the app's webhook source, without an actor.
        yield* linkLocal(agent, app.id, "svc", shared, "app");
        const sources = yield* settleWebhookSources(
          agent,
          appPath,
          sourcesAre({ [shared]: { status: "ready", failure: null } }),
        );
        expect(sources.map((source) => source.actor)).toEqual([null]);
        const [hook] = yield* settleWebhookSubscriptions(agent, appPath, (rows) =>
          rows.some((row) => row.status === "active"),
        );
        expect(hook).toMatchObject({ name: "incoming", actor: null, sourceAccount: shared });
        if (hook === undefined) return yield* Effect.die("Missing subscription");

        // A delivery runs without a caller, with the app's linked account.
        const delivered = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(hook.callbackUrl).pathname,
          { id: "event-one" },
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        expect(delivered.body).toEqual({ hasUser: false, account: shared, source: shared });

        // An account linked only for the local user is its own source, running as the user.
        yield* linkLocal(agent, app.id, "mine", personal);
        const both = yield* settleWebhookSources(
          agent,
          appPath,
          (rows) =>
            rows.length === 2 && ready(shared, null)(rows) && ready(personal, "local")(rows),
        );
        expect(both).toHaveLength(2);
        // The same account may be linked in both scopes. Linking it for the user replaces the plain
        // user requirement's earlier link, and it stays one source, serving as its app link.
        yield* linkLocal(agent, app.id, "mine", shared);
        expect(yield* localAccountLinks(agent, app.id)).toEqual([["mine", shared]]);
        expect(yield* localAccountLinks(agent, app.id, "app")).toEqual([["svc", shared]]);
        const one = yield* settleWebhookSources(
          agent,
          appPath,
          sourcesAre({ [shared]: { status: "ready", failure: null } }),
        );
        expect(one.map((source) => source.actor)).toEqual([null]);

        // Unlinking the app link hands the source back to the local user, who still links it. The
        // app's plain `svc` requirement now has no app link, so the user's source waits for one.
        yield* unlinkLocal(agent, app.id, "svc", shared, "app");
        const handed = yield* settleWebhookSources(
          agent,
          appPath,
          (rows) =>
            rows.length === 1 &&
            rows.some(
              (row) =>
                row.account === shared &&
                row.actor === "local" &&
                row.status === "needs-setup" &&
                row.failure === "accounts",
            ),
        );
        expect(handed.map((source) => source.account)).toEqual([shared]);

        // Unlinking the last link unregisters the source and stops its subscription.
        yield* unlinkLocal(agent, app.id, "mine", shared);
        yield* settleWebhookSources(agent, appPath, (rows) => rows.length === 0);
        yield* settleWebhookSubscriptions(agent, appPath, (rows) =>
          rows.every((row) => row.status === "stopped"),
        );
        const late = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(hook.callbackUrl).pathname,
          { id: "event-two" },
        );
        expect(late.status, JSON.stringify(late.body)).not.toBe(200);
      }),
    ),
  );

  it.effect(scenarios.localMcpAppAccountTools.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent, target, app, saveServiceAccounts, track } = yield* deployLocal(
          "Agent links",
          appLinkFiles,
        );
        const evidence = yield* Evidence,
          mcp = yield* McpClient;
        const [service] = yield* saveServiceAccounts("synthetic-agent-service");
        if (service === undefined) return yield* Effect.die("Account fixture missing");
        const client = yield* mcp.connect(target.apiKey, "local-app-account-tools");
        /** Run code with the Executor app's tools and return how its execution ended. */
        const run = (step: string, code: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    execution: Schema.Union([
                      Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
                      Schema.Struct({
                        ok: Schema.Literal(false),
                        error: Schema.Struct({
                          response: Schema.Struct({ code: Schema.String, status: Schema.Number }),
                        }),
                      }),
                    ]),
                  }),
                )(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution),
            );
        const execute = (step: string, code: string) =>
          run(step, code).pipe(
            Effect.flatMap((execution) =>
              execution.ok
                ? Effect.succeed(execution.value)
                : Effect.die(new Error(`${step}: ${JSON.stringify(execution)}`)),
            ),
          );
        const at = (requirement?: string, account?: string) =>
          JSON.stringify({
            path: {
              app: app.id,
              ...(requirement === undefined ? {} : { requirement }),
              ...(account === undefined ? {} : { account }),
            },
          });
        const Links = Schema.Array(
          Schema.Struct({
            requirement: Schema.String,
            account: Schema.Struct({ id: Schema.String }),
          }),
        );
        const pairs = (value: unknown) =>
          Schema.decodeUnknownEffect(Links)(value).pipe(
            Effect.map((links) => links.map((link) => [link.requirement, link.account.id])),
          );

        // The Executor app names the link tools as hosted does, in both scopes. Connecting goes
        // through them, so the old request tool is gone.
        const tools = ["app", "user"].flatMap((scope) =>
          ["List", "Get", "Link", "Unlink", "Connect"].map(
            (action) => `tools.executor.appAccounts.${scope}${action}`,
          ),
        );
        const described = yield* execute(
          "Describe the link tools",
          `return await tools.search.describe({ paths: ${JSON.stringify([...tools, "tools.executor.accountConnect.issue"])} });`,
        );
        yield* evidence.json("local-app-account-tools.json", described);
        const { missing } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ missing: Schema.Array(Schema.Struct({ path: Schema.String })) }),
        )(described);
        expect(missing.map((item) => item.path)).toEqual(["tools.executor.accountConnect.issue"]);

        // The agent connects a user account through a browser link, which links it for the user.
        const ConnectLink = Schema.Struct({ connection: Schema.String, url: Schema.String });
        const issued = yield* Schema.decodeUnknownEffect(ConnectLink)(
          yield* execute(
            "Connect a user account",
            `return await tools.executor.appAccounts.userConnect({ ...${at("mine")}, body: {} });`,
          ),
        );
        const submitted = yield* api.request(agent, "POST", "/account-connect/api/submit", {
          connection: issued.connection,
          token: new URLSearchParams(new URL(issued.url).hash.slice(1)).get("token"),
          method: "key",
          label: "synthetic-agent-mine",
          fields: { token: "synthetic-agent-mine" },
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const mine = (yield* body(SavedAccount, submitted)).id;
        track(mine);
        expect(
          yield* pairs(
            yield* execute(
              "List user links",
              `return await tools.executor.appAccounts.userList(${at()});`,
            ),
          ),
        ).toEqual([["mine", mine]]);

        // It reads an app requirement's choices, links a saved account for every call, and calls
        // with both links.
        const choices = yield* Schema.decodeUnknownEffect(Requirement)(
          yield* execute(
            "Read the app requirement",
            `return await tools.executor.appAccounts.appGet(${at("svc")});`,
          ),
        );
        expect(choices).toMatchObject({ requirement: "svc", scope: "app", cardinality: "one" });
        expect(choices.accounts).toContainEqual({
          account: { id: service, provider: expect.any(String) },
          linked: false,
        });
        yield* execute(
          "Link the app account",
          `return await tools.executor.appAccounts.appLink(${at("svc", service)});`,
        );
        expect(
          yield* pairs(
            yield* execute(
              "List app links",
              `return await tools.executor.appAccounts.appList(${at()});`,
            ),
          ),
        ).toEqual([["svc", service]]);
        expect(yield* callLocalQuery(agent, app.id, "who")).toEqual({ app: service, user: mine });

        // A connection for the app's own requirement needs the app scope, and a user connection
        // naming it is refused before any link is issued.
        const refused = yield* run(
          "Connect the app requirement as a user one",
          `return await tools.executor.appAccounts.userConnect({ ...${at("svc")}, body: {} });`,
        );
        expect(refused).toMatchObject({
          ok: false,
          error: { response: { code: "RequirementMismatch", status: 422 } },
        });
        const appLink = yield* Schema.decodeUnknownEffect(ConnectLink)(
          yield* execute(
            "Connect an app account",
            `return await tools.executor.appAccounts.appConnect({ ...${at("svc")}, body: {} });`,
          ),
        );
        yield* execute(
          "Cancel the app connection",
          `return await tools.executor.accountConnections.cancel({ path: { connection: ${JSON.stringify(appLink.connection)} } });`,
        );

        // Unlinking in each scope leaves the accounts saved and the app without links.
        yield* execute(
          "Unlink both accounts",
          `await tools.executor.appAccounts.appUnlink(${at("svc", service)});
return await tools.executor.appAccounts.userUnlink(${at("mine", mine)});`,
        );
        expect(
          yield* execute(
            "List both scopes",
            `return [await tools.executor.appAccounts.appList(${at()}), await tools.executor.appAccounts.userList(${at()})];`,
          ),
        ).toEqual([[], []]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localManagedAppLinksFixed.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent, target } = yield* localAgent;
        const mcp = yield* McpClient;
        const apps = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String, owner: Schema.String })),
          yield* api.request(agent, "GET", "/v1/apps"),
        );
        const managed = apps.find((app) => app.owner === "executor-local");
        if (managed === undefined) return yield* Effect.die("The local Executor app is missing");
        const links = yield* localAccountLinks(agent, managed.id);
        const [[requirement, account] = []] = links;
        if (requirement === undefined || account === undefined)
          return yield* Effect.die("The local Executor app has no linked account");
        expect(links).toEqual([["executor", account]]);

        /** Each change to the Executor app's links is refused with the same typed error. */
        const blocked = (step: string, response: { status: number; body: unknown }) => {
          expect(response.status, `${step}: ${JSON.stringify(response.body)}`).toBe(409);
          expect(response.body, step).toMatchObject({
            _tag: "AppAccountLinksBlocked",
            app: managed.id,
          });
        };
        const path = (scope: "app" | "user", tail: string) =>
          `${localAppPath(managed.id)}/accounts/${scope}/${tail}`;
        blocked(
          "Unlink the managed account",
          yield* api.request(agent, "DELETE", path("user", `executor/${account}`)),
        );
        blocked(
          "Link the managed account again",
          yield* api.request(agent, "PUT", path("user", `executor/${account}`)),
        );
        blocked(
          "Replace the managed account",
          yield* api.request(agent, "PUT", path("user", "executor/acc_synthetic_replacement")),
        );
        blocked(
          "Unlink it as an app account",
          yield* api.request(agent, "DELETE", path("app", `executor/${account}`)),
        );
        blocked(
          "Connect a replacement account",
          yield* api.request(agent, "POST", path("user", "executor/connections"), {
            method: "apiKey",
            fields: { baseUrl: "http://127.0.0.1:9", apiKey: "synthetic-replacement-key" },
          }),
        );
        expect(yield* localAccountLinks(agent, managed.id)).toEqual([["executor", account]]);

        // An agent's own Executor tools are refused the same way, and keep working afterwards.
        const client = yield* mcp.connect(target.apiKey, "local-managed-app-links");
        const run = (step: string, code: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    execution: Schema.Union([
                      Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
                      Schema.Struct({
                        ok: Schema.Literal(false),
                        error: Schema.Struct({
                          response: Schema.Struct({ code: Schema.String, status: Schema.Number }),
                        }),
                      }),
                    ]),
                  }),
                )(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution),
            );
        const at = JSON.stringify({
          path: { app: managed.id, requirement: "executor", account },
        });
        expect(
          yield* run(
            "Unlink the Executor app's account with its own tool",
            `return await tools.executor.appAccounts.userUnlink(${at});`,
          ),
        ).toMatchObject({
          ok: false,
          error: { response: { code: "AppAccountLinksBlocked", status: 409 } },
        });
        const listed = yield* run(
          "List the Executor app's links with its own tool",
          `return await tools.executor.appAccounts.userList(${JSON.stringify({ path: { app: managed.id } })});`,
        );
        expect(listed).toMatchObject({
          ok: true,
          value: [{ requirement: "executor", account: { id: account } }],
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localUserWebhookRequirements.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent, app, saveServiceAccounts } = yield* deployLocal("User webhooks", [
          { path: "index.ts", content: userWebhookRequirementsSource(serviceProvider) },
          appsManifest,
        ]);
        yield* userWebhookRequirements({
          reader: agent,
          appPath: localAppPath(app.id),
          actor: "local",
          add: (requirement, token) =>
            Effect.gen(function* () {
              const [account] = yield* saveServiceAccounts(token);
              if (account === undefined) return yield* Effect.die("Account fixture missing");
              yield* linkLocal(agent, app.id, requirement, account);
              return account;
            }),
          link: (requirement, account) => linkLocal(agent, app.id, requirement, account),
          unlink: (requirement, account) => unlinkLocal(agent, app.id, requirement, account),
        });
      }),
    ),
  );

  it.effect(scenarios.localMcpLinkSwappedMidExecution.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...operator,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return operator.send(method, path, data, { ...rest, ...headers });
          },
        };
        const { app, connect } = yield* deployLocal("Swap", [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, query, mutation, object, router, secrets, string, boolean } from "apps";
const service = ${serviceProvider};
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({
    who: query({ description: "Name the account", input: object({}) }, async (ctx) => ctx.user.accounts.service.fields.token),
    ${holdTools}
  }),
}));`,
          },
          appsManifest,
        ]);
        const replacement = yield* connect("service", "synthetic-replacement");
        const granted = yield* connect("service", "synthetic-granted");
        expect(yield* localLinks(agent, app.id)).toEqual([granted]);
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Granted account only",
          apps: [
            { app: app.id, runsAs: [{ kind: "account", id: granted }], tools: { kind: "all" } },
          ],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        const client = yield* mcp.connect(yield* consent.tokens, "local-link-swap", {
          connection: connection.id,
        });
        const slug = JSON.stringify(app.slug);
        const run = yield* client
          .use("Call with the granted account, wait, and call again", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `const first = await tools[${slug}].who({});
await tools[${slug}].enter({});
await tools[${slug}].hold({});
let second;
try { second = await tools[${slug}].who({}); } catch (error) { second = { refused: String(error.message) }; }
return { first, second };`,
                },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(Effect.forkChild);
        const call = (tool: string, kind: "query" | "mutation") =>
          api.request(agent, "POST", "/v1/tools/call", { app: app.id, tool, kind, input: {} }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Completed, response)),
          );
        yield* untilHeld(
          call("entered", "query").pipe(
            Effect.flatMap((called) => Schema.decodeUnknownEffect(Schema.Boolean)(called.value)),
          ),
        );
        // The link is replaced while the execution is held; the grant still names only the first.
        yield* linkLocal(agent, app.id, "service", replacement);
        expect(yield* localLinks(agent, app.id)).toEqual([replacement]);
        yield* call("release", "mutation");
        const result = yield* Fiber.join(run);
        yield* evidence.json("link-swap-execution.json", result.structuredContent);
        const { execution } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({
              ok: Schema.Literal(true),
              value: Schema.Struct({
                first: Schema.String,
                second: Schema.Struct({ refused: Schema.String }),
              }),
            }),
          }),
        )(result.structuredContent);
        expect(execution.value.first).toBe("synthetic-granted");
        // The grant does not target the replacement, so the call is refused for running with an
        // account the connection may not use, and the replacement is never used.
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TargetRefusal))(
            execution.value.second.refused,
          ),
        ).toEqual(targetRefusal(app.id, replacement));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localMcpLinkedAppAccount.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...operator,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return operator.send(method, path, data, { ...rest, ...headers });
          },
        };
        // One app uses only its app-linked account; the other also uses the caller's linked account.
        const solo = yield* deployLocal("Solo app account", [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, query, object, router, secrets, string } from "apps";
const service = ${serviceProvider};
export default defineApp({ app: { accounts: { svc: service } } }, async () => ({
  tools: router({
    shared: query({ description: "Read with the app account", input: object({}) }, async (ctx) => ctx.app.accounts.svc.fields.token),
  }),
}));`,
          },
          appsManifest,
        ]);
        const mixed = yield* deployLocal("Mixed accounts", [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, query, object, router, secrets, string } from "apps";
const service = ${serviceProvider};
const mail = ${mailProvider};
export default defineApp({ app: { accounts: { svc: service } }, user: { accounts: { mine: mail } } }, async () => ({
  tools: router({
    both: query({ description: "Read with both accounts", input: object({}) }, async (ctx) => ({ app: ctx.app.accounts.svc.fields.token, user: ctx.user.accounts.mine.fields.token })),
  }),
}));`,
          },
          appsManifest,
        ]);
        const [shared] = yield* solo.saveServiceAccounts("synthetic-shared-service");
        if (shared === undefined) return yield* Effect.die("Account fixture missing");
        yield* linkLocal(agent, solo.app.id, "svc", shared, "app");
        yield* linkLocal(agent, mixed.app.id, "svc", shared, "app");
        const mine = yield* mixed.connect("mine", "synthetic-mine");
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        // A grant names the user accounts it runs with; app access covers the app's linked account.
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "App accounts",
          apps: [
            { app: solo.app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } },
            { app: mixed.app.id, runsAs: [{ kind: "account", id: mine }], tools: { kind: "all" } },
          ],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        const client = yield* mcp.connect(yield* consent.tokens, "local-linked-app-account", {
          connection: connection.id,
        });
        const execute = (step: string, code: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    status: Schema.Literal("completed"),
                    execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
                  }),
                )(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution.value),
            );
        const soloPath = `tools[${JSON.stringify(solo.app.slug)}]`;
        const mixedPath = `tools[${JSON.stringify(mixed.app.slug)}]`;

        expect(
          yield* execute(
            "Call both apps",
            `return { shared: await ${soloPath}.shared({}), both: await ${mixedPath}.both({}) };`,
          ),
        ).toEqual({
          shared: "synthetic-shared-service",
          both: { app: "synthetic-shared-service", user: "synthetic-mine" },
        });

        // Discovery names the caller's linked account and never the app's.
        const Namespaces = Schema.Struct({
          namespaces: Schema.Array(
            Schema.Struct({
              path: Schema.String,
              app: Schema.String,
              accounts: Schema.optional(Schema.String),
            }),
          ),
        });
        const searched = yield* execute(
          "Search both apps",
          `return [await tools.search({ namespace: ${JSON.stringify(solo.app.slug)} }), await tools.search({ namespace: ${JSON.stringify(mixed.app.slug)} })];`,
        );
        yield* evidence.json("linked-app-account-search.json", searched);
        const [soloSearch, mixedSearch] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Namespaces, Namespaces]),
        )(searched);
        expect(soloSearch.namespaces).toEqual([{ path: soloPath, app: expect.any(String) }]);
        expect(mixedSearch.namespaces).toMatchObject([
          { path: mixedPath, accounts: `mine: ${mine} (synthetic-mine)` },
        ]);
        const described = yield* execute(
          "Describe both tools",
          `return await tools.search.describe({ paths: [${JSON.stringify(`${soloPath}.shared`)}, ${JSON.stringify(`${mixedPath}.both`)}] });`,
        );
        yield* evidence.json("linked-app-account-describe.json", described);
        for (const text of [JSON.stringify(searched), JSON.stringify(described)]) {
          expect(text).not.toContain(shared);
          expect(text).not.toContain("synthetic-shared-service");
          expect(text).not.toContain("svc");
          expect(text).not.toContain("$accounts");
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
