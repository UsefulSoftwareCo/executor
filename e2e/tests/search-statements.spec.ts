/**
 * MCP `search` reads every app the caller can reach before it ranks their kept tool listings, and
 * each SQL statement is a network round trip from Cloud's session object to the database. Search
 * reads what discovery needs for all of the request's apps together, so the statements under
 * `mcp.search` do not grow with the number of apps: the regression guard is the count with a few
 * apps against the count with several times as many, of each kind discovery treats differently (an
 * app without accounts, one with a linked key account, one whose requirement has no linked account,
 * and two whose OAuth account must reconnect, one the caller's and one the app's own). Each item
 * still comes from its own app, and each app whose account must reconnect is still reported as
 * unavailable, naming whose account it is as resolving it would.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

/** Every tool names its app's marker, so an item shows which app it came from. */
const tool = (marker: string, account: string) =>
  `probe: query({ description: "Search statements probe ${marker}.", input: object({}), output: string() }, async () => ${account})`;

const accountlessSource = (
  marker: string,
) => `import { defineApp, object, string, query, router } from "apps";
export default defineApp({}, { tools: router({ ${tool(marker, '"none"')} }) });`;

const keySource = (
  marker: string,
) => `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Search statements key", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ctx => ({
  tools: router({ ${tool(marker, "ctx.user.accounts.service.id")} }),
}));`;

const unlinkedSource = (
  marker: string,
) => `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Search statements unlinked", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ctx => ({
  tools: router({ ${tool(marker, "String(ctx.user.accounts.service.length)")} }),
}));`;

/** An OAuth app whose `service` account is the caller's (`user`) or the app's own (`app`). */
const oauthSource = (
  discover: string,
  scope: "user" | "app",
  marker: string,
) => `import { defineApp, defineProvider, oauth2, object, string, query, router } from "apps";
const service = defineProvider({ name: "Search statements OAuth", auth: {
  oauth: oauth2({ discover: ${JSON.stringify(discover)} })
} });
export default defineApp({ ${scope}: { accounts: { service } } }, async ctx => ({
  tools: router({ ${tool(marker, `ctx.${scope}.accounts.service.fields.access_token`)} }),
}));`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const SearchPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
  unavailableApps: Schema.optional(
    Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
  ),
});

layer(HostedLive, { excludeTestServices: true })("Search statements", (it) => {
  it.effect(
    scenarios.searchStatements.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            mcp = yield* McpClient,
            http = yield* HttpClient.HttpClient,
            issuer = yield* oauthSetupIssuer;
          const organization = actors.organization.id;
          const prefix = `/api/organizations/${organization}`;
          const accounts: string[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.forEach(
              accounts,
              (account) =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                  .pipe(Effect.map((response) => expect(response.status).toBe(200))),
              { discard: true },
            ).pipe(Effect.orDie),
          );
          /** Each deployed app, by the marker its tool names. */
          const deployed = new Map<
            string,
            { readonly id: string; readonly slug: string; readonly path: string }
          >();
          const deploy = (kind: string, source: (marker: string) => string) =>
            Effect.gen(function* () {
              const marker = `${kind}-${randomUUID().slice(0, 8)}`;
              const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name: `Search statements ${marker}`,
                files: [{ path: "index.ts", content: source(marker) }, appsManifest],
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const app = yield* body(App, response);
              const path = `${prefix}/apps/${app.id}`;
              yield* Effect.addFinalizer(() =>
                api.request(actors.owner, "DELETE", path).pipe(
                  Effect.map((removed) => expect(removed.status).toBe(200)),
                  Effect.orDie,
                ),
              );
              deployed.set(marker, { id: app.id, slug: app.slug, path });
              return { app, path, marker };
            });
          /** Connecting an account from the app links it for the owner, or for the app. */
          const connection = (path: string, scope: "user" | "app" = "user") =>
            api.request(actors.owner, "POST", connectionsPath(path, scope, "service"), {}).pipe(
              Effect.tap((pending) => Effect.sync(() => expect(pending.status).toBe(200))),
              Effect.flatMap((pending) => body(Resource, pending)),
            );
          const linked = (path: string, account: string, scope: "user" | "app" = "user") =>
            Effect.gen(function* () {
              accounts.push(account);
              expect(yield* linkedAccountIds(actors.owner, path, scope)).toEqual([account]);
            });
          const keyApp = Effect.gen(function* () {
            const { path } = yield* deploy("key", keySource);
            const pending = yield* connection(path);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${pending.id}/submit`,
              { method: "key", label: "Synthetic", fields: { token: "synthetic-search" } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            yield* linked(path, (yield* body(Resource, saved)).id);
          });
          /** Apps of every kind but the OAuth one, `count` of each. */
          const deployKinds = (count: number) =>
            Effect.forEach(
              Array.from({ length: count }),
              () =>
                Effect.all([
                  deploy("accountless", accountlessSource),
                  keyApp,
                  deploy("unlinked", unlinkedSource),
                ]),
              { discard: true },
            );

          // Two OAuth apps whose service ends the grant, one using the caller's account and one
          // the app's own: each next use marks its account for reconnecting.
          yield* issuer.configure({ expiresIn: 1 });
          const signedIn = (scope: "user" | "app") =>
            Effect.gen(function* () {
              const app = yield* deploy(`oauth${scope}`, (marker) =>
                oauthSource(`${issuer.origin}/mcp`, scope, marker),
              );
              const pending = yield* connection(app.path, scope);
              const started = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${pending.id}/oauth/start`,
                { method: "oauth", label: `Synthetic OAuth ${scope}` },
              );
              expect(started.status, JSON.stringify(started.body)).toBe(200);
              const { authorizationUrl } = yield* body(SignIn, started);
              const callbackUrl = yield* Effect.scoped(
                Effect.gen(function* () {
                  const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                  expect(consent.status).toBe(302);
                  const location = consent.headers.location;
                  if (location === undefined)
                    return yield* Effect.die("Issuer did not return a callback");
                  return location;
                }),
              ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
              const completed = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${pending.id}/oauth/complete`,
                { callbackUrl },
              );
              expect(completed.status, JSON.stringify(completed.body)).toBe(200);
              yield* linked(app.path, (yield* body(Resource, completed)).id, scope);
              return app;
            });
          const oauth = yield* signedIn("user");
          const appOauth = yield* signedIn("app");
          yield* Effect.sleep("1500 millis");
          yield* issuer.configure({
            tokenError: { status: 400, body: { error: "invalid_grant" } },
          });
          yield* Effect.forEach(
            [oauth, appOauth],
            (app) =>
              api
                .request(actors.owner, "POST", `${app.path}/tools/call`, {
                  tool: "probe",
                  kind: "query",
                  input: {},
                })
                .pipe(
                  Effect.map((ended) => expect(ended.status, JSON.stringify(ended.body)).toBe(409)),
                ),
            { discard: true },
          );

          /** An MCP connection with an API key of `actor`. */
          const connect = (actor: typeof actors.owner, name: string) =>
            Effect.gen(function* () {
              const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
                name,
              });
              expect(created.status).toBe(200);
              const token = yield* body(Token, created);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actor, "POST", "/api/auth/api-key/delete", { keyId: token.id })
                  .pipe(Effect.orDie),
              );
              return yield* mcp.connect(token.key, "pat", { organization });
            });
          const client = yield* connect(actors.owner, "Search statements");
          type Connection = typeof client;

          /** One MCP search, its page and the SQL statements made under `mcp.search`. */
          const search = (operation: string, client: Connection) =>
            Effect.gen(function* () {
              const called = yield* client.use(operation, (client, signal) =>
                client.callTool(
                  { name: "search", arguments: { query: "search statements probe", limit: 100 } },
                  undefined,
                  { signal },
                ),
              );
              const page = yield* Schema.decodeUnknownEffect(SearchPage)(called.structuredContent);
              const request = (yield* evidence.requests)
                .filter((request) => request.path === "/mcp")
                .at(-1);
              if (request === undefined)
                return yield* Effect.die(new Error("MCP request evidence missing"));
              const traced = yield* telemetry.query(request.traceId).pipe(
                Effect.flatMap((result) => {
                  const root = result.data.find(
                    (entry) => entry.span.operationName === "mcp.search",
                  );
                  const complete = result.data.some(
                    (entry) => entry.span.tags["http.response.status_code"] === "200",
                  );
                  if (root === undefined || !complete)
                    return Effect.fail(
                      new Error("The completed server trace must reach the collector"),
                    );
                  const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
                  const path = (spanId: string | null) => {
                    const names: string[] = [];
                    const visited = new Set<string>();
                    let parent = spanId;
                    while (parent !== null && !visited.has(parent)) {
                      if (parent === root.span.spanId) return names;
                      visited.add(parent);
                      const span = byId.get(parent);
                      names.push(span?.operationName ?? "");
                      parent = span?.parentSpanId ?? null;
                    }
                    return undefined;
                  };
                  const statements = result.data.flatMap(({ span }) => {
                    if (span.operationName !== "sql.execute") return [];
                    const names = path(span.parentSpanId);
                    if (names === undefined) return [];
                    return [
                      {
                        text: String(span.tags["db.query.text"] ?? "")
                          .replace(/\s+/g, " ")
                          .slice(0, 100),
                        under: names.slice(0, 6).join(" < "),
                      },
                    ];
                  });
                  return statements.length === 0
                    ? Effect.fail(new Error("SQL descendants must reach the collector"))
                    : Effect.succeed(statements);
                }),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
                Effect.timeout("25 seconds"),
              );
              return { traceId: request.traceId, page, statements: traced };
            });

          yield* deployKinds(1);
          // The first search keeps each new app's listing as search rows; the next one reads them.
          yield* search("Keep the listings of a few apps", client);
          const few = yield* search("Search a few apps", client);
          yield* deployKinds(4);
          yield* search("Keep the listings of several times as many apps", client);
          const many = yield* search("Search several times as many apps", client);

          // A member may use only the apps shared with them: the apps without accounts are shared
          // with everyone, and the owner's other apps stay private.
          const shared = [...deployed].filter(([marker]) => marker.startsWith("accountless-"));
          yield* Effect.forEach(
            shared,
            ([, app]) =>
              Effect.gen(function* () {
                const access = yield* body(
                  Schema.Struct({ revision: Schema.String }),
                  yield* api.request(actors.owner, "GET", `${app.path}/access`),
                );
                const changed = yield* api.request(actors.owner, "PATCH", `${app.path}/access`, {
                  revision: access.revision,
                  audience: { kind: "everyone" },
                });
                expect(changed.status, JSON.stringify(changed.body)).toBe(200);
              }),
            { discard: true },
          );
          const memberClient = yield* connect(actors.member, "Search statements member");
          const member = yield* search("Search as a member", memberClient);
          yield* evidence.json("search-statements.json", {
            apps: { few: 4, many: 16 },
            few: { count: few.statements.length, ...few },
            many: { count: many.statements.length, ...many },
            member: { count: member.statements.length, ...member },
          });

          /** The markers of the probes a page found; other apps, such as the built-in one, may match. */
          const probesOf = (label: string, result: typeof few) =>
            result.page.items.flatMap((item) => {
              const marker = /Search statements probe ([a-z]+-[0-9a-f]{8})\./.exec(
                item.description,
              )?.[1];
              if (marker === undefined) return [];
              const app = deployed.get(marker);
              expect(app, `${label}: ${item.description}`).toBeDefined();
              expect(item.path, `${label}: an item is its own app's tool`).toBe(
                `tools[${JSON.stringify(app?.slug)}].probe`,
              );
              return [marker];
            });
          expect(
            probesOf("member", member).sort(),
            "A member finds the shared apps' tools and none of the owner's private apps'",
          ).toEqual(shared.map(([marker]) => marker).sort());

          for (const [label, result, apps] of [
            ["few", few, 3],
            ["many", many, 15],
          ] as const) {
            const markers = probesOf(label, result);
            expect(
              markers.every((marker) => !marker.startsWith("oauth")),
              `${label}: the apps whose account must reconnect list no tools`,
            ).toBe(true);
            expect(new Set(markers).size, `${label}: one item per app that lists tools`).toBe(apps);
            const reason = (app: { readonly marker: string }) =>
              result.page.unavailableApps?.find(
                (unavailable) => unavailable.app === deployed.get(app.marker)?.id,
              )?.reason;
            expect(
              reason(oauth),
              `${label}: the app whose caller's account must reconnect is reported`,
            ).toContain("OAuthReconnectRequired");
            expect(
              reason(oauth),
              `${label}: the caller is told to reconnect their own account`,
            ).not.toContain("someone who can edit");
            expect(
              reason(appOauth),
              `${label}: the app whose own account must reconnect is reported as the app's`,
            ).toContain("someone who can edit the app must reconnect it");
          }
          expect(
            many.statements.length,
            "Search reads every app's discovery state in statements that do not grow with the apps",
          ).toBe(few.statements.length);
          expect(
            few.statements.length,
            "Listing the apps and their access twice, the access and links of every app, the caller's links, the apps, accounts, kept rows, rechecks and grants of every target, and the ranking",
          ).toBe(12);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
