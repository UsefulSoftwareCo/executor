/** Real Better Auth, persisted PGlite and retained Node builds exercise the production host router. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SourceSnapshot, Account, AccountConnection, App, AppSlug } from "@executor-js/sdk/core";
import { appAddresses } from "@executor-js/hosted-server/app-ui";
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiForbidden } from "apps/ui/contracts";
import { ConfigProvider, Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { selfHostDatabase } from "../src/database.ts";
import { selfHostRoutes } from "../src/main.ts";

const origin = "http://127.0.0.1:55439";
const secret = "synthetic-private-app-account-secret";
const Result = Schema.Struct({ message: Schema.String, connected: Schema.Boolean });
const files = [
  {
    path: "index.ts",
    content: `import { mutation, defineApp, defineProvider, defineDatabase, table, array, secrets, object, string , query} from "apps";
const database = defineDatabase({ messages: table({ body: string() }) });
const message = object({ body: string() });
const service = defineProvider({ name: "Fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service }, database }, async ({ accounts }) => ({
    queries: {
        messages: query({ input: object({}), output: array(message) }, async ({ db }) => db.messages.withIndex("by_creation").collect()),
    },
    mutations: {
        add: mutation({ input: message, output: message }, async ({ db }, value) => db.messages.insert(value)),
        broken: mutation({ input: message, output: message }, async ({ db }, value) => { await db.messages.insert(value); throw new Error("rollback"); }),
        greet: mutation({ description: "Use the saved account", input: object({ name: string() }) }, async (_, input) => ({ message: "Hello " + input.name, connected: accounts.service.fields.token === "${secret}" })),
    },
}));
`,
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Private UI</title></head><body><main>Private UI</main><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content:
      'import { createAppClient } from "apps/client"; window.addEventListener("app-ready", () => createAppClient());',
  },
];
const events = (response: Response) => {
  const reader = response.body?.getReader();
  assert.ok(reader);
  let text = "";
  const frame = async () => {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream ended before the expected event");
      text += new TextDecoder().decode(chunk.value);
    }
    const boundary = text.indexOf("\n\n");
    const frame = text.slice(0, boundary);
    text = text.slice(boundary + 2);
    return frame;
  };
  return {
    next: async () => {
      let value = await frame();
      while (value.includes('"type":"heartbeat"')) value = await frame();
      return value;
    },
    close: () => reader.cancel(),
  };
};
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
const UiLocation = Schema.Struct({ url: Schema.String });
const Redirect = Schema.Struct({ url: Schema.String });
const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });

test("app host routing uses exact configured suffixes and leaves the dashboard reachable", async () => {
  const addresses = appAddresses(
    "http://executor-self-host.localhost:1355",
    AppUiBaseUrl.make("http://localhost:4400"),
  );
  const address = await Effect.runPromise(
    addresses.origin({ slug: AppSlug.make("support-inbox") }, OrganizationSlug.make("my-team")),
  );
  const host = new URL(address).host;
  assert.equal(host, "support-inbox.my-team.localhost:4400");
  assert.deepEqual(Option.getOrThrow(addresses.fromHost(host)).find, { slug: "support-inbox" });
  assert.equal(Option.getOrThrow(addresses.fromHost(host)).slug, "my-team");
  for (const invalid of [
    host.replace(":4400", ":4401"),
    host + ".example.net",
    "user@" + host,
    host + "/path",
    "app-invalid.extra.example.localhost:4400",
    "support--inbox--my-team.localhost:4400",
    "support-inbox---my-team.localhost:4400",
    "support-inbox-my-team.localhost:4400",
  ]) {
    assert.equal(Option.isNone(addresses.fromHost(invalid)), true);
  }
  assert.equal(addresses.ownsHost("executor-self-host.localhost:1355"), false);
  assert.equal(addresses.ownsHost("app-invalid.example.localhost:4400"), true);
  assert.equal(Schema.is(AppUiBaseUrl)("http://apps.example.net"), false);
  assert.equal(Schema.is(AppUiBaseUrl)("https://apps.example.net/"), false);
  assert.equal(Schema.is(AppUiBaseUrl)("https://apps.example.net"), true);
});

test(
  "private self-host app pages use durable scoped sessions, fresh roles and saved accounts",
  { timeout: 120_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "self-host-app-ui-" });
          const dashboard = path.join(directory, "web");
          yield* fs.makeDirectory(dashboard);
          yield* fs.writeFileString(
            path.join(dashboard, "index.html"),
            "<main>Executor dashboard</main>",
          );
          const config = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            DASHBOARD_DIR: dashboard,
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: "synthetic-self-host-app-ui-signing-secret",
            EXECUTOR_ENCRYPTION_KEY: "ab".repeat(32),
          });
          const phase = <A, E>(
            run: (
              send: (
                host: string,
                path: string,
                body?: unknown,
                cookie?: string,
                headers?: Record<string, string>,
              ) => Promise<Response>,
              sql: SqlClient.SqlClient,
            ) => Effect.Effect<A, E>,
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const routes = yield* selfHostRoutes;
                const sql = yield* SqlClient.SqlClient;
                const web = yield* Effect.acquireRelease(
                  Effect.sync(() =>
                    HttpRouter.toWebHandler(
                      routes.pipe(HttpRouter.provideRequest(NodeHttpServer.layerHttpServices)),
                      { disableLogger: true },
                    ),
                  ),
                  (web) => Effect.promise(() => web.dispose()),
                );
                const send = (
                  host: string,
                  path: string,
                  body?: unknown,
                  cookie = "",
                  headers: Record<string, string> = {},
                ) =>
                  web.handler(
                    new Request(host + path, {
                      method: body === undefined ? "GET" : "POST",
                      headers: {
                        host: new URL(host).host,
                        origin: host,
                        cookie,
                        "content-type": "application/json",
                        ...headers,
                      },
                      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    }),
                  );
                return yield* run(send, sql);
              }),
            ).pipe(
              Effect.provide(selfHostDatabase),
              Effect.provideService(ConfigProvider.ConfigProvider, config),
            );
          const saved = yield* phase((send, sql) =>
            Effect.gen(function* () {
              const setup = yield* Effect.promise(() =>
                send(origin, "/api/auth/self-host/setup", {
                  name: "Owner",
                  email: "owner@example.test",
                  password: "synthetic-password-123",
                  organizationName: "Example",
                }),
              );
              assert.equal(setup.status, 200);
              const parent = cookies(setup);
              const organizations = yield* sql`select id, slug from "organization"`;
              const organization = Schema.decodeUnknownSync(Organization)(organizations[0]);
              const prefix = `/api/organizations/${organization.id}`;
              const deployed = yield* Effect.promise(() =>
                send(origin, `${prefix}/apps/deploy`, { name: "Private UI", files }, parent),
              );
              assert.equal(
                deployed.status,
                200,
                yield* Effect.promise(() => deployed.clone().text()),
              );
              const app = Schema.decodeUnknownSync(Schema.toCodecJson(App))(
                yield* Effect.promise(() => deployed.json()),
              );
              const connection = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${app.id}/connections`,
                  { requirement: "service" },
                  parent,
                ),
              );
              assert.equal(connection.status, 200);
              const pending = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
                yield* Effect.promise(() => connection.json()),
              );
              const connected = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/connections/${pending.id}/submit`,
                  { method: "key", label: "Default", fields: { token: secret } },
                  parent,
                ),
              );
              assert.equal(connected.status, 200);
              const account = Schema.decodeUnknownSync(Schema.toCodecJson(Account))(
                yield* Effect.promise(() => connected.json()),
              );
              const location = yield* Effect.promise(() =>
                send(origin, `${prefix}/apps/${app.id}/ui`, undefined, parent),
              );
              assert.equal(location.status, 200);
              const appOrigin = Schema.decodeUnknownSync(UiLocation)(
                yield* Effect.promise(() => location.json()),
              ).url;
              assert.equal(
                new URL(appOrigin).hostname,
                `${app.slug}.${organization.slug}.localhost`,
              );
              const returnTo = "/inbox?folder=starred#message-42";
              const page = yield* Effect.promise(() =>
                send(appOrigin, "/inbox?folder=starred", undefined, "", { accept: "text/html" }),
              );
              assert.equal(page.status, 200);
              assert.match(yield* Effect.promise(() => page.text()), /_executor\/auth\/browser.js/);
              const started = yield* Effect.promise(() =>
                send(appOrigin, "/_executor/auth/start", { returnTo }),
              );
              assert.equal(started.status, 200);
              const proofCookie = cookies(started);
              const login = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => started.json())).url,
              );
              const request = login.searchParams.get("request");
              assert.ok(request);
              assert.equal(login.origin, origin);
              assert.equal(login.pathname, "/app-auth");
              assert.equal(
                (yield* Effect.promise(() => send(origin, "/api/app-ui/authorize", { request })))
                  .status,
                401,
              );
              const authorized = yield* Effect.promise(() =>
                send(origin, "/api/app-ui/authorize", { request }, parent),
              );
              assert.equal(authorized.status, 200);
              const callback = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => authorized.json()))
                  .url,
              );
              const payload = Object.fromEntries(new URLSearchParams(callback.hash.slice(1)));
              assert.equal(callback.origin, appOrigin);
              const another = yield* Effect.promise(() =>
                send(origin, `${prefix}/apps/deploy`, { name: "Another UI", files }, parent),
              );
              assert.equal(another.status, 200);
              const otherApp = Schema.decodeUnknownSync(Schema.toCodecJson(App))(
                yield* Effect.promise(() => another.json()),
              );
              const otherConnection = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${otherApp.id}/connections`,
                  { requirement: "service" },
                  parent,
                ),
              );
              const otherPending = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
                yield* Effect.promise(() => otherConnection.json()),
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(
                    origin,
                    `${prefix}/connections/${otherPending.id}/submit`,
                    { method: "key", label: "Other", fields: { token: secret } },
                    parent,
                  ),
                )).status,
                200,
              );
              const otherOrigin = appOrigin.replace(`${app.slug}.`, `${otherApp.slug}.`);
              // Even copying the proof cookie and code to another valid app cannot consume this attempt.
              assert.equal(
                (yield* Effect.promise(() =>
                  send(otherOrigin, "/_executor/auth/complete", payload, proofCookie),
                )).status,
                401,
              );
              assert.equal(
                (yield* Effect.promise(() => send(appOrigin, "/_executor/auth/complete", payload)))
                  .status,
                401,
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(appOrigin, "/_executor/auth/complete", payload, proofCookie, { origin }),
                )).status,
                403,
              );
              const secondGrant = yield* Effect.promise(() =>
                send(origin, "/api/app-ui/authorize", { request }, parent),
              );
              assert.equal(secondGrant.status, 200);
              const secondCallback = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => secondGrant.json()))
                  .url,
              );
              const secondPayload = Object.fromEntries(
                new URLSearchParams(secondCallback.hash.slice(1)),
              );
              const finished = yield* Effect.promise(() =>
                Promise.all([
                  send(appOrigin, "/_executor/auth/complete", payload, proofCookie),
                  send(appOrigin, "/_executor/auth/complete", secondPayload, proofCookie),
                ]),
              );
              assert.deepEqual(finished.map((response) => response.status).sort(), [200, 401]);
              const winner = finished.find((response) => response.status === 200);
              assert.ok(winner);
              assert.deepEqual(yield* Effect.promise(() => winner.json()), { returnTo });
              const session = winner.headers
                .getSetCookie()
                .find((cookie) => cookie.startsWith("executor_app="));
              assert.ok(session);
              assert.match(session, /HttpOnly/);
              assert.doesNotMatch(session, /Domain=/);
              const appCookie = session.split(";")[0];
              assert.ok(appCookie);
              const appToken = appCookie.slice(appCookie.indexOf("=") + 1);
              const rows = yield* sql`select value, identifier from "verification"`;
              assert.ok(
                !JSON.stringify(rows).includes(appToken),
                "Only a token digest may be persisted",
              );
              assert.ok(
                !JSON.stringify(rows).includes(payload.code ?? "missing"),
                "Authorization codes are not stored in plaintext",
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(origin, "/api/app-ui/authorize", { request }, appCookie),
                )).status,
                401,
              );
              const document = yield* Effect.promise(() =>
                send(appOrigin, returnTo.split("#")[0] ?? "/", undefined, appCookie),
              );
              assert.equal(document.status, 200);
              const html = yield* Effect.promise(() => document.text());
              assert.match(html, /Private UI/);
              assert.match(html, /executor-context/);
              assert.doesNotMatch(html, /watch\.js/);
              const script = /src="((?!\/_executor\/)[^"]+\.js)"/.exec(html)?.[1];
              assert.ok(script);
              const asset = yield* Effect.promise(() =>
                send(
                  appOrigin,
                  `/_executor/assets/${app.activeDeployment}/${script}`,
                  undefined,
                  appCookie,
                ),
              );
              assert.equal(asset.status, 200);
              assert.ok(!(yield* Effect.promise(() => asset.text())).includes(secret));
              assert.equal(
                (yield* Effect.promise(() =>
                  send(appOrigin, `/_executor/assets/${app.activeDeployment}/${script}`),
                )).status,
                401,
              );
              assert.equal(
                (yield* Effect.promise(() => send(appOrigin, "/missing.js", undefined, appCookie)))
                  .status,
                404,
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(
                    otherOrigin,
                    "/_executor/api/mutate",
                    {
                      deployment: otherApp.activeDeployment,
                      name: "greet",
                      input: { name: "Other" },
                    },
                    appCookie,
                  ),
                )).status,
                401,
              );
              const call = {
                deployment: app.activeDeployment,
                name: "greet",
                input: { name: "Ada" },
              };
              const output = yield* Effect.promise(() =>
                send(appOrigin, "/_executor/api/mutate", call, appCookie),
              );
              assert.equal(output.status, 200, yield* Effect.promise(() => output.clone().text()));
              assert.deepEqual(
                Schema.decodeUnknownSync(Result)(yield* Effect.promise(() => output.json())),
                { message: "Hello Ada", connected: true },
              );
              const query = { deployment: app.activeDeployment, name: "messages", input: {} };
              const subscribed = yield* Effect.promise(() =>
                send(appOrigin, "/_executor/api/subscribe", query, appCookie),
              );
              assert.equal(subscribed.status, 200);
              const live = events(subscribed);
              assert.match(yield* Effect.promise(live.next), /snapshot/);
              const created = yield* Effect.promise(() =>
                send(
                  appOrigin,
                  "/_executor/api/mutate",
                  {
                    deployment: app.activeDeployment,
                    name: "add",
                    input: { body: "Persisted data" },
                  },
                  appCookie,
                ),
              );
              assert.equal(
                created.status,
                200,
                yield* Effect.promise(() => created.clone().text()),
              );
              assert.match(yield* Effect.promise(live.next), /Persisted data/);
              yield* Effect.promise(live.close);
              const read = yield* Effect.promise(() =>
                send(appOrigin, "/_executor/api/query", query, appCookie),
              );
              assert.deepEqual(yield* Effect.promise(() => read.json()), [
                { body: "Persisted data" },
              ]);
              assert.equal(
                (yield* Effect.promise(() =>
                  send(
                    appOrigin,
                    "/_executor/api/mutate",
                    {
                      deployment: app.activeDeployment,
                      name: "broken",
                      input: { body: "Rolled back" },
                    },
                    appCookie,
                  ),
                )).status,
                422,
              );
              const agentRead = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${app.id}/tools/call`,
                  { tool: "queries.messages", input: {} },
                  parent,
                ),
              );
              assert.equal(agentRead.status, 200);
              assert.deepEqual(yield* Effect.promise(() => agentRead.json()), [
                { body: "Persisted data" },
              ]);
              const agentRollback = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${app.id}/tools/call`,
                  { tool: "mutations.broken", input: { body: "Agent rollback" } },
                  parent,
                ),
              );
              assert.equal(agentRollback.status, 502);
              const managementRead = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${app.id}/data/query`,
                  { name: "messages", input: {} },
                  parent,
                ),
              );
              assert.equal(managementRead.status, 200);
              assert.deepEqual(yield* Effect.promise(() => managementRead.json()), [
                { body: "Persisted data" },
              ]);
              const otherRead = yield* Effect.promise(() =>
                send(
                  origin,
                  `${prefix}/apps/${otherApp.id}/data/query`,
                  { name: "messages", input: {} },
                  parent,
                ),
              );
              assert.deepEqual(yield* Effect.promise(() => otherRead.json()), []);
              assert.equal(
                (yield* Effect.promise(() =>
                  send(appOrigin, "/api/auth/get-session", undefined, appCookie),
                )).status,
                404,
              );
              // Expiration must reject both the login page and a later callback, not merely clean up records.
              const expired = yield* Effect.promise(() =>
                send(appOrigin, "/_executor/auth/start", { returnTo: "/" }),
              );
              const expiredLogin = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => expired.json())).url,
              );
              const expiredRequest = expiredLogin.searchParams.get("request");
              assert.ok(expiredRequest);
              const expiringGrant = yield* Effect.promise(() =>
                send(origin, "/api/app-ui/authorize", { request: expiredRequest }, parent),
              );
              assert.equal(expiringGrant.status, 200);
              const expiringCallback = new URL(
                Schema.decodeUnknownSync(Redirect)(
                  yield* Effect.promise(() => expiringGrant.json()),
                ).url,
              );
              const expiredPayload = Object.fromEntries(
                new URLSearchParams(expiringCallback.hash.slice(1)),
              );
              yield* sql`update "verification" set "expiresAt" = now() - interval '1 minute' where identifier like 'executor-app-ui:v1:grant:%'`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(appOrigin, "/_executor/auth/complete", expiredPayload, cookies(expired)),
                )).status,
                401,
              );
              yield* sql`update "verification" set "expiresAt" = now() - interval '1 minute' where identifier = ${`executor-app-ui:v1:attempt:${expiredRequest}`}`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(origin, "/api/app-ui/authorize", { request: expiredRequest }, parent),
                )).status,
                401,
              );
              return {
                parent,
                appCookie,
                appOrigin,
                app: app.id,
                deployment: app.activeDeployment,
                account: account.id,
                organization: organization.id,
                slug: organization.slug,
              };
            }),
          );
          yield* phase((send, sql) =>
            Effect.gen(function* () {
              const persisted = yield* Effect.promise(() =>
                send(
                  saved.appOrigin,
                  "/_executor/api/query",
                  { deployment: saved.deployment, name: "messages", input: {} },
                  saved.appCookie,
                ),
              );
              assert.deepEqual(yield* Effect.promise(() => persisted.json()), [
                { body: "Persisted data" },
              ]);
              // All in-memory services were released. The parent and app sessions and assets remain usable.
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/inbox", undefined, saved.appCookie),
                )).status,
                200,
              );
              const call = {
                deployment: saved.deployment,
                name: "greet",
                input: { name: "Grace" },
              };
              assert.deepEqual(
                yield* Effect.promise(async () =>
                  (
                    await send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie)
                  ).json(),
                ),
                { message: "Hello Grace", connected: true },
              );
              yield* sql`update "member" set role = 'member' where "organizationId" = ${saved.organization}`;
              // A private app remains usable by its creator under the current sharing policy.
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                200,
              );
              const [policy] = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ creator: Schema.NonEmptyString })),
              )(
                yield* sql`select creator_id as creator from hosted_app_access where id = ${saved.app}`,
              );
              assert.ok(policy);
              // Revocation must affect the existing app session without a new sign-in.
              yield* sql`update hosted_app_access set creator_id = null where id = ${saved.app}`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                403,
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(
                    saved.appOrigin,
                    "/_executor/api/mutate",
                    { deployment: saved.deployment, name: "add", input: { body: "Denied" } },
                    saved.appCookie,
                  ),
                )).status,
                403,
              );
              yield* sql`update hosted_app_access set creator_id = ${policy.creator} where id = ${saved.app}`;
              yield* sql`update "member" set role = 'owner' where "organizationId" = ${saved.organization}`;
              // Corrupt selections/ownership cannot turn an app session into cross-organization authority.
              yield* sql`update executor_accounts set owner = 'organization:other' where id = ${saved.account}`;
              const wrongAccount = yield* Effect.promise(() =>
                send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
              );
              assert.equal(wrongAccount.status, 403);
              Schema.decodeUnknownSync(UiForbidden)(
                yield* Effect.promise(() => wrongAccount.json()),
              );
              yield* sql`update executor_accounts set owner = ${`organization:${saved.organization}`} where id = ${saved.account}`;
              yield* sql`update executor_apps set owner = 'organization:other' where id = ${saved.app}`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                403,
              );
              yield* sql`update executor_apps set owner = ${`organization:${saved.organization}`} where id = ${saved.app}`;
              yield* sql`insert into "organization" (id, name, slug, "createdAt") values ('other', 'Other', 'other', now())`;
              const watching = yield* Effect.promise(() =>
                send(
                  saved.appOrigin,
                  "/_executor/api/subscribe",
                  { deployment: saved.deployment, name: "messages", input: {} },
                  saved.appCookie,
                ),
              );
              assert.equal(watching.status, 200);
              const revocation = events(watching);
              assert.match(yield* Effect.promise(revocation.next), /Persisted data/);
              yield* sql`update "member" set "organizationId" = 'other' where "organizationId" = ${saved.organization}`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/inbox", undefined, saved.appCookie),
                )).status,
                403,
              );
              assert.match(yield* Effect.promise(revocation.next), /UiForbidden/);
              yield* Effect.promise(revocation.close);
              yield* sql`update "member" set "organizationId" = ${saved.organization} where "organizationId" = 'other'`;
              yield* sql`delete from "organization" where id = 'other'`;
              yield* sql`update "organization" set slug = 'renamed' where id = ${saved.organization}`;
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/inbox", undefined, saved.appCookie),
                )).status,
                403,
              );
              const renamed = saved.appOrigin.replace(`.${saved.slug}.`, ".renamed.");
              assert.equal(
                (yield* Effect.promise(() =>
                  send(renamed, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                401,
              );
              yield* sql`update "organization" set slug = ${saved.slug} where id = ${saved.organization}`;
              const appPath = `/api/organizations/${saved.organization}/apps/${saved.app}`;
              const workspaceResponse = yield* Effect.promise(() =>
                send(origin, `${appPath}/workspace`, undefined, saved.parent),
              );
              assert.equal(workspaceResponse.status, 200);
              const workspace = yield* Schema.decodeUnknownEffect(SourceSnapshot)(
                yield* Effect.promise(() => workspaceResponse.json()),
              );
              const committedResponse = yield* Effect.promise(() =>
                send(
                  origin,
                  `${appPath}/commits`,
                  { expected: workspace.revision.commit, files, message: "Update private app" },
                  saved.parent,
                ),
              );
              assert.equal(committedResponse.status, 200);
              const committed = yield* Schema.decodeUnknownEffect(SourceSnapshot)(
                yield* Effect.promise(() => committedResponse.json()),
              );
              const changed = yield* Effect.promise(() =>
                send(
                  origin,
                  `${appPath}/deploy`,
                  {
                    expectedSource: committed.revision.commit,
                    expectedDeployment: saved.deployment,
                  },
                  saved.parent,
                ),
              );
              assert.equal(changed.status, 200);
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                409,
              );
              const pending = yield* Effect.promise(() =>
                send(saved.appOrigin, "/_executor/auth/start", { returnTo: "/" }),
              );
              const login = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => pending.json())).url,
              );
              const request = login.searchParams.get("request");
              assert.ok(request);
              const authorized = yield* Effect.promise(() =>
                send(origin, "/api/app-ui/authorize", { request }, saved.parent),
              );
              assert.equal(authorized.status, 200);
              const callback = new URL(
                Schema.decodeUnknownSync(Redirect)(yield* Effect.promise(() => authorized.json()))
                  .url,
              );
              const payload = Object.fromEntries(new URLSearchParams(callback.hash.slice(1)));
              const signOut = yield* Effect.promise(() =>
                send(origin, "/api/auth/sign-out", {}, saved.parent),
              );
              assert.equal(signOut.status, 200);
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/api/mutate", call, saved.appCookie),
                )).status,
                401,
              );
              assert.equal(
                (yield* Effect.promise(() =>
                  send(saved.appOrigin, "/_executor/auth/complete", payload, cookies(pending)),
                )).status,
                401,
              );
            }),
          );
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerHttpServices)),
    ),
);
