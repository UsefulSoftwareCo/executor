/** The private app protocol is checked through each real hosted product and its browser runtime. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

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
const GeneratedOperation = Schema.Struct({
  name: Schema.String,
  method: Schema.String,
  path: Schema.String,
  security: Schema.Array(Schema.Array(Schema.String)),
  streaming: Schema.optionalKey(Schema.Boolean),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const InvalidAddress = Schema.Struct({ reason: Schema.Literal("too_long") });

layer(HostedLive, { excludeTestServices: true })("Private app pages", (it) => {
  it.effect(scenarios.appUi.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const anonymous = yield* api.session();
        const apiDocument = yield* body(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Record(Schema.String, PublicOperation)),
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
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Private UI ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const seeded = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/data/mutate`,
          { name: "save", input: { body: "Saved from the management API" } },
        );
        expect(seeded.status).toBe(200);
        const location = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(location.status).toBe(200);
        const { url } = yield* body(Location, location);
        expect(new URL(url).hostname.split(".")[0]).toBe(
          `${app.slug}--${actors.organization.slug}`,
        );
        const bookmark = `${url}/inbox/unread?filter=new#latest`;
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
        yield* browser.use("Direct bookmark requires the existing product login", (page) =>
          page.goto(bookmark),
        );
        yield* browser.use("Sign-in return stays on the dashboard", (page) =>
          page.getByRole("heading", { name: "Sign in to Executor", exact: true }).waitFor(),
        );
        yield* browser.login(actors.owner);
        // Inventory provisions the ordinary Executor app's managed account for this owner.
        const inventory = yield* body(
          Schema.Struct({
            apps: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                slug: Schema.String,
                accounts: Schema.Record(Schema.String, Schema.Unknown),
              }),
            ),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        expect(
          inventory.apps.find((item) => item.slug === "executor")?.accounts.service,
        ).toBeDefined();
        const management = inventory.apps.find((item) => item.slug === "executor");
        if (management === undefined) return yield* Effect.die("Executor app was not installed");
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
        const metadataFile = source.files.find((file) => file.path === "operations.json");
        if (metadataFile === undefined)
          return yield* Effect.die("Executor app has no operations metadata");
        const metadata = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              operations: Schema.Array(GeneratedOperation),
            }),
          ),
        )(metadataFile.content);
        const expected = Object.entries(apiDocument.paths)
          .flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, operation]) => ({
              name: operation.operationId.replace(/[^a-zA-Z0-9_]/g, "_"),
              method: method.toUpperCase(),
              path,
              security: operation.security.map((requirement) => Object.keys(requirement).sort()),
            })),
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        expect(
          metadata.operations
            .map(({ streaming: _streaming, ...operation }) => operation)
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(expected);
        expect(
          metadata.operations.find((operation) => operation.name === "appData_subscribe")
            ?.streaming,
        ).toBe(true);
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
                  code: 'return await tools.search({ query: "executor", limit: 100 });',
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
          "tools.executor.queries.appUi_location",
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          "tools.executor.mutations.appUi_authorize",
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          "tools.executor.queries.viewer_get",
        );
        expect(discovered.items.map((item) => item.path)).not.toContain(
          "tools.executor.mutations.appData_subscribe",
        );
        const lookup = yield* client.use(
          "Get the canonical app URL using the MCP grant",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools.executor.queries.appUi_location({ path: ${JSON.stringify({ organization: actors.organization.id, app: app.id })} });`,
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
                  code: `return await tools.executor.queries.appUi_location({ path: ${JSON.stringify({ organization: "other-organization", app: app.id })} });`,
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

        yield* browser.use("An existing dashboard login automatically opens the app", (page) =>
          page.goto(`${mcpLocation.url}/inbox/unread?filter=new#latest`),
        );
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
        yield* browser.use("A member can open an explicitly shared app", (page) => page.reload());
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
        // Exercise the public rename and location APIs at the combined DNS-label boundary.
        const maxAppSlug = 63 - 2 - actors.organization.slug.length;
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
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: `${boundaryName}a`,
          })).status,
        ).toBe(200);
        const tooLong = yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`);
        expect(tooLong.status).toBe(422);
        expect((yield* body(InvalidAddress, tooLong)).reason).toBe("too_long");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/name`, {
            name: app.name,
          })).status,
        ).toBe(200);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
