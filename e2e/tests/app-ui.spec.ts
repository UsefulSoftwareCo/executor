/** The private app protocol is checked through each real hosted product and its browser runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";

import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { managementApp } from "../support/management-app.ts";
import { holdQuery } from "../support/query-transition.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, table, query, mutation, object, string } from "apps";
const database = defineDatabase({ messages: table({ body: string() }) });
export const list = query({ input: object({}) }, async ({ db }) =>
  (await db.messages.withIndex("by_creation").collect()).map((row) => row.body));
export const save = mutation({ input: object({ body: string() }) }, async ({ db }, input) => {
  await db.messages.insert(input); return input.body;
});
export default defineApp({ accounts: {}, database }, {  queries: { list }, mutations: { save } });`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Private app</title><link rel="stylesheet" href="./style.css"></head><body>
<main><h1>Private app</h1><img src="./mark.svg" alt="Fixture logo"><form><label>Message<input name="message"></label><button>Save message</button></form><ul aria-label="Messages"></ul><p role="status">Loading</p></main><script type="module" src="./main.ts"></script></body></html>`,
  },
  { path: "ui/style.css", content: ":root { --fixture-asset: loaded; }" },
  {
    path: "ui/public/mark.svg",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="teal"/></svg>',
  },
  {
    path: "ui/main.ts",
    content: `import { array, string } from "apps";
import { createAppClient, queryReference, mutationReference } from "apps/client";
import type { list, save } from "../index.ts";
const client = createAppClient();
const status = document.querySelector('[role="status"]');
const load = async () => {
 const rows = await client.query(queryReference<typeof list>("list"), {}, array(string()));
 document.querySelector('ul').replaceChildren(...rows.map((body) => { const li = document.createElement('li'); li.textContent = body; return li; }));
 status.textContent = "Ready";
};
document.querySelector('form').addEventListener('submit', (event) => {
 event.preventDefault();
 const body = new FormData(event.currentTarget).get('message');
 client.mutate(mutationReference<typeof save>("save"), { body }, string()).then(load).catch(() => { status.textContent = "Save failed"; });
});
load().catch(() => { status.textContent = "Load failed"; });`,
  },
];
const Location = Schema.Struct({ url: Schema.String });
const OperationSecurity = Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String)));
const PublicOperation = Schema.Struct({ operationId: Schema.String, security: OperationSecurity });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

const appFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    browser = yield* Browser,
    target = yield* Target;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Private UI ${randomUUID().slice(0, 8)}`,
    files,
  });
  expect(deployed.status).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
  const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
  expect(new URL(url).hostname.split(".").slice(0, 2).join(".")).toBe(
    `${app.slug}.${actors.organization.slug}`,
  );
  const bookmark = `${url}/inbox/unread?filter=new#latest`;
  return { api, actors, browser, target, prefix, app, url, bookmark };
});

layer(HostedLive, { excludeTestServices: true })("Private app pages", (it) => {
  it.effect(scenarios.appUiDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, prefix, app, url, target } = yield* appFixture;
        yield* browser.login(actors.owner);
        const anonymous = yield* api.session();
        const apiDocument = yield* body(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Record(Schema.String, PublicOperation)),
            components: Schema.Struct({
              securitySchemes: Schema.Record(Schema.String, Schema.Json),
            }),
          }),
          yield* api.request(anonymous, "GET", "/openapi.json"),
        );
        expect(Object.keys(apiDocument.paths)).toContain(
          "/api/organizations/{organization}/apps/{app}/ui",
        );
        expect(Object.keys(apiDocument.paths)).toContain("/api/app-ui/authorize");
        expect(Object.keys(apiDocument.paths)).toContain("/api/viewer");
        expect(apiDocument.paths["/api/app-ui/authorize"]?.post?.security).toEqual([
          { browserSession: [] },
        ]);
        const { app: management, profile } = yield* managementApp(actors.owner);
        expect(profile.accounts.service).toBeTypeOf("string");
        const tools = `tools.executor.profiles[${JSON.stringify(profile.id)}]`;
        const source = yield* body(
          Schema.Struct({
            files: Schema.Array(
              Schema.Struct({
                path: Schema.String,
                content: Schema.String,
              }),
            ),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${management.id}/source`),
        );
        const configurationFile = source.files.find((file) => file.path === "openapi.json");
        if (configurationFile === undefined)
          return yield* Effect.die("Executor app has no live OpenAPI configuration");
        const configuration = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              source: Schema.Struct({ url: Schema.String }),
              baseUrl: Schema.String,
              allowedOrigin: Schema.String,
              securitySchemes: Schema.Record(Schema.String, Schema.Json),
            }),
          ),
        )(configurationFile.content);
        expect(configuration.source.url).toBe(`${target.metadata.origin}/openapi.json`);
        expect(configuration.baseUrl).toBe(target.metadata.origin);
        expect(configuration.allowedOrigin).toBe(new URL(target.metadata.origin).origin);
        expect(configuration.securitySchemes).toEqual(apiDocument.components.securitySchemes);
        const oauth = yield* McpOAuth;
        const mcp = yield* McpClient;
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "app-ui-discovery",
        );
        const search = yield* client.use(
          "Discover the app URL tool through MCP",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  // Keep the discovery assertion below MCP's output limit as signatures grow.
                  code: 'const result = await tools.search({ query: "executor", limit: 100 }); return { items: result.items.map(({ path }) => ({ path })) };',
                },
              },
              undefined,
              { signal },
            ),
        );
        const discovered = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            items: Schema.Array(Schema.Struct({ path: Schema.String })),
          }),
        )((yield* Schema.decodeUnknownEffect(Completed)(search.structuredContent)).execution.value);
        expect(discovered.items.map((item) => item.path)).toContain(
          `${tools}.queries.appUi_location`,
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          `${tools}.mutations.appUi_authorize`,
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          `${tools}.queries.viewer_get`,
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          `${tools}.mutations.appData_subscribe`,
        );
        const lookup = yield* client.use(
          "Get the canonical app URL using the MCP grant",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${tools}.queries.appUi_location({ path: ${JSON.stringify({ organization: actors.organization.id, app: app.id })} });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const mcpLocation = yield* Schema.decodeUnknownEffect(Location)(
          (yield* Schema.decodeUnknownEffect(Completed)(lookup.structuredContent)).execution.value,
        );
        expect(mcpLocation.url).toBe(url);
        const denied = yield* client.use(
          "An MCP grant cannot discover another organization's URL",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await ${tools}.queries.appUi_location({ path: ${JSON.stringify({ organization: "other-organization", app: app.id })} });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const failed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Literal(false) }),
          }),
        )(denied.structuredContent);
        expect(failed.execution.ok).toBe(false);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.appUi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, target, prefix, app, url, bookmark } = yield* appFixture;
        const seeded = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/data/mutate`,
          {
            name: "save",
            input: { body: "Saved from the management API" },
          },
        );
        expect(seeded.status).toBe(200);
        yield* browser.omitNetworkTrace;
        expect(
          (yield* browser.use("Unsigned protected assets stay private", (page) =>
            page.context().request.get(`${url}/mark.svg`),
          )).status(),
        ).toBe(401);
        expect(
          (yield* browser.use("App origin has no management routes", (page) =>
            page.context().request.get(`${url}/api/auth/get-session`),
          )).status(),
        ).toBe(404);
        expect(
          yield* browser.use("Reserved product roots are not app pages", (page) =>
            Promise.all(
              ["/api", "/mcp", "/_executor", "/.well-known"].map((path) =>
                page
                  .context()
                  .request.get(`${url}${path}`, { maxRedirects: 0 })
                  .then((response) => [path, response.status()] as const),
              ),
            ),
          ),
        ).toEqual([
          ["/api", 404],
          ["/mcp", 404],
          ["/_executor", 404],
          ["/.well-known", 404],
        ]);
        yield* browser.use("Direct bookmark requires the existing product login", (page) =>
          page.goto(bookmark),
        );
        yield* browser.use("Sign-in return stays on the dashboard", (page) =>
          page
            .getByRole("heading", {
              name: target.metadata.target === "cloud" ? "Sign in" : "Sign in to Executor",
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.login(actors.owner);
        yield* openPrivateApp(bookmark);
        yield* browser.use("App query executes after authentication", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.use("App pages read data saved through the management API", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved from the management API" }).waitFor(),
        );
        expect(
          yield* browser.use("The original path query and fragment survive sign-in", (page) =>
            Promise.resolve(page.url()),
          ),
        ).toBe(bookmark);
        expect(
          yield* browser.use("Retained image is loaded", (page) =>
            page
              .locator("img")
              .evaluate((image) =>
                image instanceof HTMLImageElement
                  ? image.decode().then(() => image.complete && image.naturalWidth === 24)
                  : false,
              ),
          ),
        ).toBe(true);
        expect(
          yield* browser.use("Retained CSS is loaded", (page) =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--fixture-asset").trim(),
            ),
          ),
        ).toBe("loaded");
        const session = yield* browser.use("App cookie is host-only and HttpOnly", (page) =>
          page
            .context()
            .cookies(url)
            .then((cookies) => {
              const cookie = cookies.find((cookie) => cookie.name.endsWith("executor_app"));
              return cookie && { httpOnly: cookie.httpOnly, domain: cookie.domain };
            }),
        );
        expect(session).toEqual({ httpOnly: true, domain: new URL(url).hostname });
        expect(
          (yield* browser.use("Missing assets remain 404", (page) =>
            page.context().request.get(`${url}/missing.js`),
          )).status(),
        ).toBe(404);
        expect(
          (yield* browser.use("Cross-origin writes are rejected", (page) =>
            page.context().request.post(`${url}/_executor/api/mutate`, {
              headers: { origin: "https://other.example.test" },
              data: {},
            }),
          )).status(),
        ).toBe(403);
        yield* browser.use("Enter a message", (page) =>
          page.getByLabel("Message", { exact: true }).fill("Saved through app runtime"),
        );
        yield* browser.use("Run the saved app mutation", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Read the committed app data", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved through app runtime" }).waitFor(),
        );
        yield* browser.checkpoint("Private app query and mutation");
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/data/query`,
          {
            name: "list",
            input: {},
          },
        );
        expect(saved.status).toBe(200);
        expect(yield* body(Schema.Array(Schema.String), saved)).toEqual([
          "Saved from the management API",
          "Saved through app runtime",
        ]);
        yield* browser.use("A bookmark revisit reuses the app session", (page) =>
          page.goto(bookmark),
        );
        yield* browser.use("Data remains after reopening", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved through app runtime" }).waitFor(),
        );
      }),
    ),
  );
  it.effect(scenarios.appUiAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, browser, prefix, app, bookmark } = yield* appFixture;
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          }),
        );
        yield* browser.login(actors.member);
        // Keep the live revocation watcher pending while testing the mutation's
        // own rejection. Starting a document navigation can cancel its response.
        const watcher = yield* holdQuery(["/_executor/version"], "continue");
        yield* openPrivateApp(bookmark);
        yield* watcher.requested;
        yield* browser.use("Member can query the app", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.use("Member enters a message", (page) =>
          page.getByLabel("Message", { exact: true }).fill("Saved by a member"),
        );
        yield* browser.use("Member writes to the shared app", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Member write succeeds", (page) =>
          page.getByRole("listitem").filter({ hasText: "Saved by a member" }).waitFor(),
        );
        const live = yield* browser.use("Open a member tab with live revocation", (page) =>
          page.context().newPage(),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Close the live member tab", () => live.close()).pipe(Effect.orDie),
        );
        const [response] = yield* Effect.all(
          [
            browser.use("Observe the live member subscription", () =>
              live.waitForResponse(
                (response) => new URL(response.url()).pathname === "/_executor/version",
              ),
            ),
            browser.use("Load the live member tab", () => live.goto(bookmark)),
          ],
          { concurrency: "unbounded" },
        );
        expect(response.status()).toBe(200);
        yield* browser.use("The live member tab is ready", () =>
          live.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: shared.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        yield* browser.use("Revoked app session attempts a write", (page) =>
          page.getByRole("button", { name: "Save message" }).click(),
        );
        yield* browser.use("Existing session loses access immediately", (page) =>
          page.getByRole("status").filter({ hasText: "Save failed" }).waitFor(),
        );
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/apps/${app.id}/ui`)).status,
        ).toBe(403);
        yield* browser.use("Revocation removes the open app from the browser", () =>
          live.getByText("App unavailable.", { exact: true }).waitFor(),
        );
        yield* watcher.release;
        // Each app has its own complete DNS label, independent of the team slug length.
        const maxAppSlug = 63;
        expect(maxAppSlug).toBeGreaterThan(0);
        const boundaryName = "a".repeat(maxAppSlug);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: boundaryName,
          })).status,
        ).toBe(200);
        const boundary = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(boundary.status).toBe(200);
        const boundaryUrl = (yield* body(Location, boundary)).url;
        expect(new URL(boundaryUrl).hostname.split(".")[0]?.length).toBe(63);
        yield* browser.login(actors.owner);
        yield* openPrivateApp(boundaryUrl);
        yield* browser.use("A 63-character app label serves the authenticated app", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        yield* browser.checkpoint("The longest app hostname works over verified HTTPS");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: `${boundaryName}a`,
          })).status,
        ).toBe(200);
        const normalized = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(normalized.status).toBe(200);
        expect((yield* body(Location, normalized)).url).toBe(boundaryUrl);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: app.name,
          })).status,
        ).toBe(200);
      }),
    ),
  );
});
