/**
 * Before local assigned owners, an agent named any owner when it deployed an app or connected an
 * account; the public docs used `alice`. Those records were missing from the dashboard and their
 * apps could not open. Upgrading gives them to `local` once, at startup, in data step
 * `7_local_owners`. The scenarios build apps and accounts through the product, then stop it and
 * rewrite their owners as the earlier server stored them: an app, its account and connections
 * under one owner, and an account connected for a local app under another. Records
 * whose owner is encrypted, a pending sign-in and a pending approval, and the identity of an OAuth
 * client's credentials are then written by the product itself, for an app that owner holds.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { dataStepSummaries, logMessages, nextDataStepSummary } from "../support/data-steps.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { ConnectedAccount, connectLocalAccount } from "../support/app-accounts.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const step = "7_local_owners";
/**
 * Each app has its own provider, so an app shares no account with another app's fixture. An
 * account connected for an app is linked to it.
 */
const source = (
  provider: string,
) => `import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";
const service = defineProvider({ name: ${JSON.stringify(provider)}, auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
export const who = query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.id);
export default defineApp({ user: { accounts: { service } } }, { tools: router({ who }) });`;
/** The app page shows the account its tool call ran with. */
const files = (provider: string) => [
  { path: "index.ts", content: source(provider) },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Moved</title></head><body><p id="identity"></p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'import {string} from "apps";import {createAppClient,queryReference} from "apps/client";import type {who} from "../index.ts";createAppClient().query(queryReference<typeof who>("who"),{},string()).then(value=>{document.querySelector("#identity").textContent=value;});',
  },
  appsManifest,
];

const App = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
const Deployed = Schema.Struct({ app: App });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Listed = Schema.Array(Schema.Struct({ id: Schema.String }));
const Pending = Schema.Struct({ id: Schema.String, owner: Schema.String });

interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<string>;
}
/** What the earlier server stored for an app and the connections made for it under `owner`. */
const ownedApp = (app: string, owner: string): [Statement, ...Statement[]] => [
  { sql: `UPDATE executor_apps SET owner = $2 WHERE id = $1`, params: [app, owner] },
  {
    sql: `UPDATE executor_deployments SET owner = $2
      WHERE code = (SELECT code FROM executor_apps WHERE id = $1)`,
    params: [app, owner],
  },
  {
    sql: `UPDATE executor_tool_search_listings SET owner = $2 WHERE app = $1`,
    params: [app, owner],
  },
  {
    sql: `UPDATE executor_account_connections
      SET target = (target::jsonb || jsonb_build_object('owner', $2::text))::json
      WHERE target->>'app' = $1`,
    params: [app, owner],
  },
];
/** What the earlier server stored for an account, and the connection that saved it, under `owner`. */
const ownedAccounts = (app: string, owner: string): [Statement, ...Statement[]] => [
  {
    sql: `UPDATE executor_accounts SET owner = $2 WHERE id IN (
      SELECT state->'account'->>'id' FROM executor_account_connections
      WHERE target->>'app' = $1 AND state->>'status' = 'completed')`,
    params: [app, owner],
  },
  {
    sql: `UPDATE executor_account_connections SET owner = $2::text,
      state = CASE WHEN state->>'status' = 'completed'
        THEN jsonb_set(state::jsonb, '{account,owner}', to_jsonb($2::text))::json ELSE state END
      WHERE target->>'app' = $1`,
    params: [app, owner],
  },
];
/** Owners of every table that has one; after the move only `local` and `executor-local`. */
const ownerTables = [
  "executor_apps",
  "executor_deployments",
  "executor_installations",
  "executor_schedules",
  "executor_scheduled_runs",
  "executor_workflow_runs",
  "executor_webhooks",
  "executor_webhook_sources",
  "executor_event_subscriptions",
  "executor_accounts",
  "executor_account_connections",
  "executor_tool_approvals",
  "executor_tool_search_listings",
  "executor_stored_oauth_clients",
  "executor_stored_oauth_client_credentials",
];
const owners = {
  sql: ownerTables
    .map((table) => `SELECT owner FROM ${table}`)
    .join(" UNION ")
    .concat(" ORDER BY owner"),
};

/** An app whose account signs in with OAuth at `issuer`, with a tool that needs approval. */
const oauthSource = (
  issuer: string,
  name: string,
) => `import { defineApp, defineProvider, mutation, oauth2, object, query, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ account: accounts.service.id, service: await (await fetch(${JSON.stringify(`${issuer}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
    approved: mutation({ input: object({}), approval: async () => "user-approval" as const }, async () => accounts.service.id),
  }),
}));`;
const OAuthApp = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const OAuthClient = Schema.Struct({ id: Schema.String, owner: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
const Resource = Schema.Struct({ id: Schema.String, owner: Schema.String });
const ApprovalRequired = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Read = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Struct({
    account: Schema.String,
    service: Schema.Struct({ refreshed: Schema.Boolean }),
  }),
});
/**
 * Every owner column, and a digest of every value a move rewrites: connection targets and states,
 * and the ciphertext of stored clients, sign-ins and approvals. Equal before and after shows a
 * step changed no product row or ciphertext; its journal still records the attempt.
 */
const stored = {
  sql: ownerTables
    .map(
      (table) =>
        `SELECT '${table}' AS "table", ${table === "executor_tool_search_listings" ? "listing" : "id"} AS id, owner AS value FROM ${table}`,
    )
    .concat(
      `SELECT 'connection', id, md5(target::text || state::text) FROM executor_account_connections`,
      `SELECT 'client', id, md5(encrypted) FROM executor_stored_oauth_clients`,
      `SELECT 'sign-in', id, md5(encrypted) FROM executor_oauth_attempts`,
      `SELECT 'approval', id, md5(encrypted) FROM executor_tool_approvals`,
    )
    .join(" UNION ALL ")
    .concat(` ORDER BY 1, 2, 3`),
};

/** A connection link for the app's account, and the grant its browser page holds. */
const connectionFor = (agent: Session, app: string) =>
  Effect.gen(function* () {
    const link = yield* body(
      Link,
      yield* agent.send("POST", "/account-connect/api/requests", {
        target: { app, requirement: "service" },
      }),
    );
    return {
      connection: link.connection,
      token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
    };
  });

/**
 * Start a connection's sign-in with a stored client and consent at the service, which accepts the
 * client at the callback the sign-in sends. Returns the callback, not yet completed.
 */
const consentWith = (
  session: Session,
  issuer: Effect.Success<typeof oauthSetupIssuer>,
  grant: Effect.Success<ReturnType<typeof connectionFor>>,
  client: { readonly id: string; readonly clientId: string; readonly clientSecret: string },
  label: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const started = yield* session.send("POST", "/account-connect/api/oauth/start", {
      ...grant,
      method: "oauth",
      label,
      client: { id: client.id },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const redirect = yield* body(Redirect, started);
    yield* issuer.allowClient({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirect: redirect.redirectUri,
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const consent = yield* HttpClient.withScope(http).get(redirect.authorizationUrl);
        expect(consent.status).toBe(302);
        const location = consent.headers.location;
        if (location === undefined) return yield* Effect.die("The service returned no callback");
        return location;
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  });

/** Pair the dashboard in the browser and wait for its app list. */
const openDashboard = (session: Session, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const pair = yield* body(
      Schema.Struct({ url: Schema.String }),
      yield* session.send("POST", "/auth/pair", undefined, headers),
    );
    yield* browser.use("Pair the local dashboard", (page) => page.goto(pair.url));
    yield* browser.use("Wait for pairing to finish", (page) =>
      page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
    );
    return browser;
  });

/** The bearer-key agent API and the browser session that pairs the dashboard. */
const agentSession = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target,
    session = yield* api.session();
  const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
  const agent: Session = {
    ...session,
    send: (method, path, data, extra = {}) => {
      const { origin: _origin, ...rest } = extra;
      return session.send(method, path, data, { ...rest, ...headers });
    },
  };
  return { session, agent, headers, log: `${target.directory}/server.log` };
});

/** Deploy an app with an account connected for it, of a provider only this app requires. */
const appWithAccount = (agent: Session, name: string, label: string) =>
  Effect.gen(function* () {
    const { app } = yield* body(
      Deployed,
      yield* agent.send("POST", "/v1/apps/deploy", {
        owner: "local",
        name,
        files: files(`Owner move fixture ${name}`),
      }),
    );
    const account = yield* connectLocalAccount(agent, {
      app: app.id,
      requirement: "service",
      method: "key",
      label,
      fields: { token: `synthetic-${randomUUID()}` },
    });
    return { app, account };
  });

layer(TestLive, { excludeTestServices: true })("Local owner migration", (it) => {
  it.effect(
    scenarios.localOwnerMigration.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const browser = yield* Browser;
          const { session, agent, headers, log } = yield* agentSession;
          const suffix = randomUUID().slice(0, 8);
          const listed = (owner: string) =>
            agent
              .send("GET", `/v1/accounts?owner=${owner}`)
              .pipe(Effect.flatMap((response) => body(Listed, response)));

          // An app deployed under `alice`, with its account, and an account the docs'
          // example connected under `bob` for an app of the local user.
          const moved = yield* appWithAccount(agent, `Moved ${suffix}`, `Alice key ${suffix}`);
          const local = yield* appWithAccount(agent, `Kept ${suffix}`, `Bob key ${suffix}`);
          yield* Effect.addFinalizer(() =>
            serverControl("start").pipe(
              Effect.andThen(
                Effect.forEach(
                  [
                    `/v1/apps/${moved.app.id}`,
                    `/v1/apps/${local.app.id}`,
                    `/v1/accounts/${moved.account.id}`,
                    `/v1/accounts/${local.account.id}`,
                  ],
                  (path) => agent.send("DELETE", path),
                ),
              ),
              Effect.orDie,
            ),
          );
          // A reconnect of the moved account, left open across the upgrade.
          const open = yield* body(
            Link,
            yield* agent.send("POST", "/account-connect/api/requests", {
              target: { app: moved.app.id, requirement: "service" },
              account: moved.account.id,
            }),
          );
          yield* legacyStorage([
            ...ownedApp(moved.app.id, "alice"),
            ...ownedAccounts(moved.app.id, "alice"),
            ...ownedAccounts(local.app.id, "bob"),
          ]);

          // A report start moves no record.
          const seen = (yield* dataStepSummaries(log, step)).length;
          yield* serverControl("data-steps", 200, { mode: "report" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
            mode: "report",
            outcomes: { would_move: 1 },
          });
          expect((yield* listed("alice")).map(({ id }) => id)).toEqual([moved.account.id]);
          expect((yield* listed("bob")).map(({ id }) => id)).toEqual([local.account.id]);
          expect((yield* listed("local")).map(({ id }) => id)).toEqual([]);

          // Applying moves every record of both owners to `local` in one pass.
          yield* serverControl("stop");
          yield* serverControl("data-steps", 200, { mode: "apply" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen + 1)).toMatchObject({
            mode: "apply",
            status: "complete",
            outcomes: { moved: 1 },
          });
          expect((yield* listed("local")).map(({ id }) => id).toSorted()).toEqual(
            [moved.account.id, local.account.id].toSorted(),
          );
          expect(yield* listed("alice")).toEqual([]);
          expect(yield* listed("bob")).toEqual([]);
          expect(
            (yield* body(App, yield* agent.send("GET", `/v1/apps/${moved.app.id}`))).owner,
          ).toBe("local");
          expect(
            (yield* logMessages(log)).some((message) =>
              message.startsWith(`Moved the records of "alice", "bob" to "local": `),
            ),
          ).toBe(true);

          // The reconnect left open completes, as connection and account moved together, and a new
          // connection is saved under `local`, whatever owner the agent names.
          const reconnected = yield* body(
            ConnectedAccount,
            yield* agent.send("POST", "/account-connect/api/submit", {
              connection: open.connection,
              token: new URLSearchParams(new URL(open.url).hash.slice(1)).get("token"),
              method: "key",
              fields: { token: "synthetic-after-upgrade" },
            }),
          );
          expect(reconnected.id).toBe(moved.account.id);
          const pending = yield* body(
            Pending,
            yield* agent.send("POST", "/v1/account-connections", {
              owner: "alice",
              target: { app: moved.app.id, requirement: "service" },
            }),
          );
          expect(pending.owner).toBe("local");
          expect(
            (yield* agent.send("POST", `/v1/account-connections/${pending.id}/cancel`)).status,
          ).toBe(200);

          // The dashboard lists the moved accounts, and the moved app opens with its own.
          const pair = yield* body(
            Schema.Struct({ url: Schema.String }),
            yield* session.send("POST", "/auth/pair", undefined, headers),
          );
          yield* browser.use("Pair the local dashboard", (page) => page.goto(pair.url));
          yield* browser.use("Wait for pairing to finish", (page) =>
            page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
          );
          yield* browser.use("Open the account list", (page) => page.goto("/accounts"));
          for (const label of [`Alice key ${suffix}`, `Bob key ${suffix}`])
            yield* browser.use(`The dashboard lists ${label}`, (page) =>
              page.getByRole("button", { name: `Manage ${label}`, exact: true }).waitFor(),
            );
          yield* browser.checkpoint("Accounts saved under other owners are listed after upgrade");
          yield* browser.use("Open the moved app's page", (page) =>
            page.goto(`/apps/${moved.app.id}`),
          );
          const ui = yield* browser.use("Read the moved app's URL", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).getAttribute("href"),
          );
          if (ui === null) return yield* Effect.die("The moved app has no URL");
          yield* browser.use("Open the moved app", (page) => page.goto(ui));
          yield* browser.use("The moved app runs with its account", (page) =>
            page.locator("#identity").filter({ hasText: moved.account.id }).waitFor(),
          );
          yield* browser.checkpoint("An app deployed under another owner opens after upgrade");

          // No record keeps another owner.
          expect(yield* legacyStorage([owners])).toEqual([
            [{ owner: "executor-local" }, { owner: "local" }],
          ]);
          // An applied step never runs again, and running its item again, as a start would after
          // a crash between the move's commit and the journal's, changes nothing.
          yield* serverControl("start");
          expect(yield* dataStepSummaries(log, step)).toHaveLength(seen + 2);
          yield* legacyStorage([
            { sql: `DELETE FROM private_local_data_steps WHERE name = $1`, params: [step] },
            { sql: `DELETE FROM private_local_data_step_items WHERE name = $1`, params: [step] },
          ]);
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen + 2)).toMatchObject({
            mode: "apply",
            status: "complete",
            outcomes: { unchanged: 1 },
          });
          expect((yield* listed("local")).map(({ id }) => id).toSorted()).toEqual(
            [moved.account.id, local.account.id].toSorted(),
          );
        }),
      ),
    // The product starts four times after its first: report, apply, unchanged and the rerun.
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.localOwnerMigrationCollision.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { session, agent, headers, log } = yield* agentSession;
          const suffix = randomUUID().slice(0, 8);
          const kept = yield* appWithAccount(agent, `Clash ${suffix}`, `Kept key ${suffix}`);
          const stray = yield* appWithAccount(agent, `Stray ${suffix}`, `Stray key ${suffix}`);
          yield* Effect.addFinalizer(() =>
            serverControl("start").pipe(
              Effect.andThen(
                Effect.forEach(
                  [
                    `/v1/apps/${kept.app.id}`,
                    `/v1/apps/${stray.app.id}`,
                    `/v1/accounts/${kept.account.id}`,
                    `/v1/accounts/${stray.account.id}`,
                  ],
                  (path) => agent.send("DELETE", path),
                ),
              ),
              Effect.orDie,
            ),
          );
          // `alice` named an app as the local user later named one of theirs.
          yield* legacyStorage([
            ...ownedApp(stray.app.id, "alice"),
            ...ownedAccounts(stray.app.id, "alice"),
            {
              sql: `UPDATE executor_apps SET (name, slug) = (SELECT name, slug FROM executor_apps WHERE id = $2)
                WHERE id = $1`,
              params: [stray.app.id, kept.app.id],
            },
          ]);
          const seen = (yield* dataStepSummaries(log, step)).length;
          yield* serverControl("data-steps", 200, { mode: "apply" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
            mode: "apply",
            status: "retrying",
            outcomes: { collision: 1 },
          });
          const error = (yield* logMessages(log)).find((message) =>
            message.includes("were not moved"),
          );
          const records = [kept.app.id, stray.app.id]
            .toSorted()
            .map((id) => `${id} (owner ${JSON.stringify(id === kept.app.id ? "local" : "alice")})`)
            .join(", ");
          // An app's slug derives from its name, so one name is one slug too.
          expect(error).toBe(
            `Records of "alice" were not moved to "local", because these would collide: apps named ${JSON.stringify(kept.app.name)}: ${records}; apps with the slug ${JSON.stringify(kept.app.slug)}: ${records}. No product rows or ciphertext changed; this attempt was recorded in the journal. Rename or remove all but one of each, then restart Executor.`,
          );

          // The dashboard names both apps, and which to rename or remove.
          const pair = [kept.app.id, stray.app.id].toSorted().map((id) => ({
            owner: id === kept.app.id ? "local" : "alice",
            id,
          }));
          expect((yield* agent.send("GET", "/dashboard/api/owner-migration")).body).toEqual({
            status: "collision",
            owners: ["alice"],
            to: "local",
            collisions: [
              { kind: "app_name", key: kept.app.name, records: pair },
              { kind: "app_slug", key: kept.app.slug, records: pair },
            ],
            blocked: [],
          });
          const browser = yield* openDashboard(session, headers);
          const shown = pair.map(({ id, owner }) => `${id} (owner “${owner}”)`).join(", ");
          yield* browser.use("The dashboard names both apps and what to do", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "Records of other owners could not move" })
              .filter({
                hasText: `Apps named “${kept.app.name}”: ${shown}. Rename or remove all but one.`,
              })
              .filter({ hasText: "Then restart Executor." })
              .waitFor(),
          );
          yield* browser.checkpoint("Another owner's app collides with a local app");

          // Nothing moved: not the app, nor the account that does not collide.
          const app = (id: string) =>
            agent
              .send("GET", `/v1/apps/${id}`)
              .pipe(Effect.flatMap((response) => body(App, response)));
          expect((yield* app(stray.app.id)).owner).toBe("alice");
          const listed = (owner: string) =>
            agent
              .send("GET", `/v1/accounts?owner=${owner}`)
              .pipe(Effect.flatMap((response) => body(Listed, response)));
          expect((yield* listed("alice")).map(({ id }) => id)).toEqual([stray.account.id]);
          // Until it moves, local does not serve the app: a connection for it is refused rather
          // than saved under the owner the app has.
          const refused = yield* agent.send("POST", "/account-connect/api/requests", {
            target: { app: stray.app.id, requirement: "service" },
          });
          expect(refused.status).toBe(404);
          expect(refused.body).toMatchObject({ _tag: "AppNotFound", app: stray.app.id });

          // Once the local user renames theirs, the next start moves everything.
          expect(
            (yield* agent.send("PATCH", `/v1/apps/${kept.app.id}/name`, {
              name: `Renamed ${suffix}`,
            })).status,
          ).toBe(200);
          yield* serverControl("restart");
          expect(yield* nextDataStepSummary(log, step, seen + 1)).toMatchObject({
            mode: "apply",
            status: "complete",
            pass: 2,
            outcomes: { moved: 1 },
          });
          expect((yield* app(stray.app.id)).owner).toBe("local");
          expect((yield* listed("local")).map(({ id }) => id).toSorted()).toEqual(
            [kept.account.id, stray.account.id].toSorted(),
          );
          expect((yield* agent.send("GET", "/dashboard/api/owner-migration")).body).toBeNull();
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.localOwnerMigrationOAuth.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { session, agent, headers, log } = yield* agentSession;
          const issuer = yield* oauthSetupIssuer;
          // Tokens expire within the renewal window, so every use of the account renews it.
          yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
          const suffix = randomUUID().slice(0, 8);
          const name = `OAuth moved ${suffix}`;
          const { app } = yield* body(
            OAuthApp,
            yield* agent.send("POST", "/v1/apps/deploy", {
              owner: "local",
              name,
              files: [
                { path: "index.ts", content: oauthSource(issuer.origin, name) },
                appsManifest,
              ],
            }),
          );
          // A client entered at the service by hand, which the agent registered.
          const credentials = {
            clientId: `synthetic-moved-${suffix}`,
            clientSecret: `synthetic-secret-${suffix}`,
          };
          const client = {
            ...credentials,
            id: (yield* body(
              OAuthClient,
              yield* agent.send("POST", "/v1/oauth-clients", {
                owner: "local",
                issuer: issuer.origin,
                ...credentials,
              }),
            )).id,
          };
          // An account signed in with it, whose grant keeps a copy of the client.
          const first = yield* connectionFor(agent, app.id);
          const signedIn = yield* body(
            Resource,
            yield* session.send("POST", "/account-connect/api/oauth/complete", {
              ...first,
              callbackUrl: yield* consentWith(
                session,
                issuer,
                first,
                client,
                `Signed in ${suffix}`,
              ),
            }),
          );
          // A second connection, whose sign-in starts once the app is another owner's.
          const second = yield* connectionFor(agent, app.id);
          let added: string | undefined;
          yield* Effect.addFinalizer(() =>
            serverControl("start").pipe(
              Effect.andThen(
                Effect.forEach(
                  [
                    `/v1/apps/${app.id}`,
                    `/v1/accounts/${signedIn.id}`,
                    ...(added === undefined ? [] : [`/v1/accounts/${added}`]),
                    `/v1/oauth-clients/${client.id}?owner=local`,
                  ],
                  (path) => agent.send("DELETE", path),
                ),
              ),
              Effect.orDie,
            ),
          );

          // The earlier server stored the app, its account, connections and client under `alice`.
          // A client's credentials are identified by a digest over its owner, so the rows written
          // for `local` go; the product writes `alice`'s below.
          yield* legacyStorage([
            ...ownedApp(app.id, "alice"),
            ...ownedAccounts(app.id, "alice"),
            {
              sql: `UPDATE executor_stored_oauth_clients SET owner = 'alice' WHERE id = $1`,
              params: [client.id],
            },
            {
              sql: `DELETE FROM executor_stored_oauth_client_credentials WHERE client = $1`,
              params: [client.id],
            },
          ]);
          yield* serverControl("start");
          // The agent edits `alice`'s client and back: each set of credentials the client holds
          // or held is recorded under `alice`'s digest, the current set and the earlier one.
          for (const details of [
            { clientId: `${credentials.clientId}-edited`, clientSecret: "synthetic-edited" },
            credentials,
          ]) {
            const edited = yield* agent.send("PATCH", `/v1/oauth-clients/${client.id}`, {
              owner: "alice",
              ...details,
            });
            expect(edited.status, JSON.stringify(edited.body)).toBe(200);
          }
          // A sign-in for `alice`, consented at the service and left to complete after the
          // upgrade, and a call of `alice`'s app waiting for approval with her linked account.
          const callback = yield* consentWith(session, issuer, second, client, `Added ${suffix}`);
          const waiting = yield* body(
            ApprovalRequired,
            yield* agent.send("POST", "/v1/tools/call", {
              app: app.id,
              tool: "approved",
              input: {},
            }),
          );

          // A report start found them, and the dashboard says they wait to move.
          const seen = (yield* dataStepSummaries(log, step)).length;
          expect((yield* dataStepSummaries(log, step)).at(-1)).toMatchObject({
            mode: "report",
            outcomes: { would_move: 1 },
          });
          const browser = yield* openDashboard(session, headers);
          yield* browser.use("The dashboard says other owners' records wait to move", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "Records of other owners wait to move" })
              .filter({ hasText: "Records of “alice” are kept apart from yours" })
              .waitFor(),
          );
          yield* browser.checkpoint("Records of another owner wait to move");

          // Applying moves all of it to `local`, rewriting the sign-in's and the approval's
          // records and recording the client's current credentials under `local`'s digest.
          yield* serverControl("stop");
          yield* serverControl("data-steps", 200, { mode: "apply" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
            mode: "apply",
            status: "complete",
            outcomes: { moved: 1 },
          });
          const moved = (yield* logMessages(log))
            .find((message) => message.startsWith(`Moved the records of "alice" to "local": `))
            ?.slice(`Moved the records of "alice" to "local": `.length);
          expect(JSON.parse(moved ?? "{}")).toMatchObject({
            storedOAuthClients: 1,
            storedOAuthClientCredentials: 2,
            "storedOAuthClientCredentials.rekeyed": 1,
            oauthAttempts: 1,
            "toolApprovals.invocation": 1,
          });

          // The approved call runs, as `local`, with the account it was saved with.
          const resumed = yield* agent.send("POST", "/v1/tools/resume", {
            requestId: waiting.requestId,
            response: { action: "accept" },
          });
          expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
          expect(resumed.body).toEqual({ status: "completed", value: signedIn.id });
          // The account signed in under `alice` renews with its grant's copy of the client.
          const before = (yield* issuer.metrics).refreshesIssued;
          const read = yield* agent.send("POST", "/v1/tools/call", {
            app: app.id,
            tool: "read",
            input: {},
          });
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          expect((yield* body(Read, read)).value).toEqual({
            account: signedIn.id,
            service: expect.objectContaining({ refreshed: true }),
          });
          expect((yield* issuer.metrics).refreshesIssued).toBeGreaterThan(before);
          // The sign-in started for `alice` completes for `local`.
          const completed = yield* session.send("POST", "/account-connect/api/oauth/complete", {
            ...second,
            callbackUrl: callback,
          });
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          const account = yield* body(Resource, completed);
          added = account.id;
          expect(account.owner).toBe("local");
          // `local` holds the client's credentials: registering them again names the moved client.
          const again = yield* agent.send("POST", "/v1/oauth-clients", {
            owner: "local",
            issuer: issuer.origin,
            ...credentials,
          });
          expect(again.status, JSON.stringify(again.body)).toBe(409);
          expect(again.body).toMatchObject({ _tag: "OAuthClientExists", client: client.id });

          // The completed sign-in linked its account to the app in place of the account signed in
          // before the upgrade, whose webhook source is removed in the background. Wait for that,
          // so the snapshot below holds only rows the data step could change.
          yield* agent.send("GET", `/v1/apps/${app.id}/webhook-sources`).pipe(
            Effect.flatMap((response) =>
              body(
                Schema.Array(Schema.Struct({ account: Schema.String, status: Schema.String })),
                response,
              ),
            ),
            Effect.flatMap((sources) =>
              sources.length === 1 &&
              sources[0]?.account === account.id &&
              sources[0].status !== "pending" &&
              sources[0].status !== "removing"
                ? Effect.void
                : Effect.fail(
                    new Error(`Webhook sources are settling: ${JSON.stringify(sources)}`),
                  ),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

          // No record keeps another owner, and running the item again changes nothing.
          expect(yield* legacyStorage([owners])).toEqual([
            [{ owner: "executor-local" }, { owner: "local" }],
          ]);
          const [after] = yield* legacyStorage([
            stored,
            { sql: `DELETE FROM private_local_data_steps WHERE name = $1`, params: [step] },
            { sql: `DELETE FROM private_local_data_step_items WHERE name = $1`, params: [step] },
          ]);
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen + 1)).toMatchObject({
            mode: "apply",
            status: "complete",
            outcomes: { unchanged: 1 },
          });
          expect((yield* legacyStorage([stored]))[0]).toEqual(after);
        }),
      ),
    // The product starts four times after its first: report, apply, the rerun and cleanup.
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.localOwnerMigrationBlocked.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { session, agent, headers, log } = yield* agentSession;
          const issuer = yield* oauthSetupIssuer;
          const suffix = randomUUID().slice(0, 8);
          const stray = yield* appWithAccount(agent, `Unread ${suffix}`, `Unread key ${suffix}`);
          const name = `Unread OAuth ${suffix}`;
          const { app } = yield* body(
            OAuthApp,
            yield* agent.send("POST", "/v1/apps/deploy", {
              owner: "local",
              name,
              files: [
                { path: "index.ts", content: oauthSource(issuer.origin, name) },
                appsManifest,
              ],
            }),
          );
          const client = (yield* body(
            OAuthClient,
            yield* agent.send("POST", "/v1/oauth-clients", {
              owner: "local",
              issuer: issuer.origin,
              clientId: `synthetic-unread-${suffix}`,
              clientSecret: `synthetic-secret-${suffix}`,
            }),
          )).id;
          yield* Effect.addFinalizer(() =>
            serverControl("start").pipe(
              Effect.andThen(
                Effect.forEach(
                  [
                    `/v1/apps/${stray.app.id}`,
                    `/v1/apps/${app.id}`,
                    `/v1/accounts/${stray.account.id}`,
                    `/v1/oauth-clients/${client}?owner=local`,
                  ],
                  (path) => agent.send("DELETE", path),
                ),
              ),
              Effect.orDie,
            ),
          );
          // `alice` holds an app with an account, and another app with a client whose record no
          // longer decrypts with this install's key: one byte of its ciphertext differs.
          yield* legacyStorage([
            ...ownedApp(stray.app.id, "alice"),
            ...ownedAccounts(stray.app.id, "alice"),
            ...ownedApp(app.id, "alice"),
            {
              sql: `UPDATE executor_stored_oauth_clients SET owner = 'alice',
                encrypted = set_byte(encrypted, 20, get_byte(encrypted, 20) # 1) WHERE id = $1`,
              params: [client],
            },
            {
              sql: `UPDATE executor_stored_oauth_client_credentials SET owner = 'alice' WHERE client = $1`,
              params: [client],
            },
          ]);
          const [before] = yield* legacyStorage([stored]);

          // Applying moves nothing, names the record, and leaves the step to retry.
          const seen = (yield* dataStepSummaries(log, step)).length;
          yield* serverControl("data-steps", 200, { mode: "apply" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
            mode: "apply",
            status: "retrying",
            outcomes: { blocked: 1 },
          });
          expect(
            (yield* logMessages(log)).find((message) => message.includes("cannot be read")),
          ).toBe(
            `Records of "alice" were not moved to "local", because these records cannot be read: oauth_client ${client} (owner "alice"): Remove it with the API key (DELETE /v1/oauth-clients/${client}?owner=alice). No product rows or ciphertext changed; this attempt was recorded in the journal. Then restart Executor.`,
          );
          const status = yield* agent.send("GET", "/dashboard/api/owner-migration");
          expect(status.body).toEqual({
            status: "blocked",
            owners: ["alice"],
            to: "local",
            collisions: [],
            blocked: [{ kind: "oauth_client", id: client, owner: "alice" }],
          });
          // The dashboard names the record and what to do about it.
          const browser = yield* openDashboard(session, headers);
          yield* browser.use("The dashboard names the record that cannot be read", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "Records of other owners could not move" })
              .filter({
                hasText: `OAuth client ${client} (owner “alice”). Remove it with the API key: DELETE /v1/oauth-clients/${client}?owner=alice`,
              })
              .filter({ hasText: "Authorization: Bearer $EXECUTOR_API_KEY" })
              .filter({ hasText: "Then restart Executor." })
              .waitFor(),
          );
          yield* browser.checkpoint("A record of another owner cannot be read");
          // No product row or ciphertext changed, and the journal records the step as not complete.
          const [after, journal] = yield* legacyStorage([
            stored,
            {
              sql: `SELECT completed_at FROM private_local_data_steps WHERE name = $1 AND run = 'apply'`,
              params: [step],
            },
          ]);
          expect(after).toEqual(before);
          expect(journal).toEqual([{ completed_at: null }]);

          // Every start tries again, and stays blocked while the record is there.
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen + 1)).toMatchObject({
            mode: "apply",
            status: "retrying",
            pass: 2,
            outcomes: { blocked: 1 },
          });
          // Once the person removes the client, the next start moves everything.
          expect(
            (yield* agent.send("DELETE", `/v1/oauth-clients/${client}?owner=alice`)).status,
          ).toBe(200);
          yield* serverControl("restart");
          expect(yield* nextDataStepSummary(log, step, seen + 2)).toMatchObject({
            mode: "apply",
            status: "complete",
            pass: 3,
            outcomes: { moved: 1 },
          });
          expect((yield* agent.send("GET", "/dashboard/api/owner-migration")).body).toBeNull();
          expect(
            (yield* body(App, yield* agent.send("GET", `/v1/apps/${stray.app.id}`))).owner,
          ).toBe("local");
          expect(yield* legacyStorage([owners])).toEqual([
            [{ owner: "executor-local" }, { owner: "local" }],
          ]);
        }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.localOwnerMigrationMalformed.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const { session, agent, headers, log } = yield* agentSession;
          const suffix = randomUUID().slice(0, 8);
          const stray = yield* appWithAccount(agent, `Malformed ${suffix}`, `Malformed ${suffix}`);
          const client = `oac_${randomUUID()}`;
          const signIn = `oauth_${randomUUID()}`;
          const approval = `apr_${randomUUID()}`;
          yield* Effect.addFinalizer(() =>
            legacyStorage([
              { sql: `DELETE FROM executor_stored_oauth_clients WHERE id = $1`, params: [client] },
              { sql: `DELETE FROM executor_oauth_attempts WHERE id = $1`, params: [signIn] },
              { sql: `DELETE FROM executor_tool_approvals WHERE id = $1`, params: [approval] },
              {
                sql: `DELETE FROM executor_account_connections WHERE target->>'app' = $1`,
                params: [stray.app.id],
              },
            ]).pipe(
              Effect.andThen(serverControl("start")),
              Effect.andThen(
                Effect.forEach(
                  [`/v1/apps/${stray.app.id}`, `/v1/accounts/${stray.account.id}`],
                  (path) => agent.send("DELETE", path),
                ),
              ),
              Effect.orDie,
            ),
          );
          // Stored timestamps are UTC without a zone; both stay pending for the whole scenario.
          const live = new Date(Date.now() + 60 * 60_000).toISOString();
          // `alice` holds an app with its account and connection. A registered client, a pending
          // sign-in and a pending approval of hers decrypt, and her connection parses, but the
          // product would not read any of them back. The client's secret reads but its
          // registration does not: it authenticates with a secret it does not hold. The sign-in
          // names only its owner and provider, the approval only its invocation's owner and an
          // account selection, and the connection's target has lost its requirement.
          yield* legacyStorage([
            ...ownedApp(stray.app.id, "alice"),
            ...ownedAccounts(stray.app.id, "alice"),
            {
              sql: `INSERT INTO executor_stored_oauth_clients
                (id, owner, provider, client_id, source, has_secret, automatic_key, confirmed, encrypted, created_at)
                VALUES ($1, 'alice', 'prv_synthetic', 'x', 'registered', false, NULL, false, $2, now())`,
              params: [
                client,
                {
                  sealed: {
                    id: client,
                    value: { client_id: "x", token_endpoint_auth_method: "client_secret_basic" },
                  },
                },
              ],
            },
            {
              sql: `INSERT INTO executor_oauth_attempts (id, encrypted, expires_at, status)
                VALUES ($1, $2, $3, 'pending')`,
              params: [
                signIn,
                { sealed: { id: signIn, value: { owner: "alice", provider: "prv_synthetic" } } },
                live,
              ],
            },
            {
              sql: `INSERT INTO executor_tool_approvals (id, owner, status, revision, encrypted, expires_at)
                VALUES ($1, 'alice', 'pending', 'synthetic', $2, $3)`,
              params: [
                approval,
                {
                  sealed: {
                    id: approval,
                    value: {
                      invocation: {
                        owner: "alice",
                        accounts: { service: { id: stray.account.id, owner: "alice" } },
                      },
                    },
                  },
                },
                live,
              ],
            },
            {
              sql: `UPDATE executor_account_connections SET target = (target::jsonb - 'requirement')::json
                WHERE target->>'app' = $1`,
              params: [stray.app.id],
            },
          ]);
          const [before, connections] = yield* legacyStorage([
            stored,
            {
              sql: `SELECT id FROM executor_account_connections WHERE target->>'app' = $1`,
              params: [stray.app.id],
            },
          ]);
          expect(connections).toHaveLength(1);
          const connection = String(connections?.[0]?.["id"]);

          // Applying moves no record, names each one with what to do, and leaves the step to
          // retry.
          const seen = (yield* dataStepSummaries(log, step)).length;
          yield* serverControl("data-steps", 200, { mode: "apply" });
          yield* serverControl("start");
          expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
            mode: "apply",
            status: "retrying",
            outcomes: { blocked: 1 },
          });
          expect((yield* agent.send("GET", "/dashboard/api/owner-migration")).body).toEqual({
            status: "blocked",
            owners: ["alice"],
            to: "local",
            collisions: [],
            blocked: [
              { kind: "oauth_client", id: client, owner: "alice" },
              { kind: "oauth_sign_in", id: signIn },
              { kind: "account_connection", id: connection, owner: "alice" },
              { kind: "tool_approval", id: approval, owner: "alice" },
            ],
          });
          expect(
            (yield* logMessages(log)).find((message) => message.includes("cannot be read")),
          ).toBe(
            `Records of "alice" were not moved to "local", because these records cannot be read: oauth_client ${client} (owner "alice"): Remove it with the API key (DELETE /v1/oauth-clients/${client}?owner=alice); oauth_sign_in ${signIn}: It expires within 10 minutes; account_connection ${connection} (owner "alice"): Executor cannot remove it. Stop Executor and restore the data directory from a backup taken before it was written; tool_approval ${approval} (owner "alice"): It expires within 15 minutes. No product rows or ciphertext changed; this attempt was recorded in the journal. Then restart Executor.`,
          );
          const browser = yield* openDashboard(session, headers);
          yield* browser.use("The dashboard says what to do about each record", (page) =>
            page
              .getByRole("alert")
              .filter({ hasText: "Records of other owners could not move" })
              .filter({
                hasText: `OAuth client ${client} (owner “alice”). Remove it with the API key: DELETE /v1/oauth-clients/${client}?owner=alice`,
              })
              .filter({ hasText: `Pending OAuth sign-in ${signIn}. It expires within 10 minutes.` })
              .filter({
                hasText: `Account connection ${connection} (owner “alice”). Executor cannot remove it. Stop Executor and restore the data directory from a backup taken before it was written.`,
              })
              .filter({
                hasText: `Pending approval ${approval} (owner “alice”). It expires within 15 minutes.`,
              })
              .waitFor(),
          );
          yield* browser.checkpoint("Records of another owner the product would not read back");
          // No product row or ciphertext changed, and the journal records the step as not complete.
          const [after, journal] = yield* legacyStorage([
            stored,
            {
              sql: `SELECT completed_at FROM private_local_data_steps WHERE name = $1 AND run = 'apply'`,
              params: [step],
            },
          ]);
          expect(after).toEqual(before);
          expect(journal).toEqual([{ completed_at: null }]);
        }),
      ),
    { timeout: 180_000 },
  );
});
