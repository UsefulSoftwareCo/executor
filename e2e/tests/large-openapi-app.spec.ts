import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { expandableOpenapiDocument, largeOpenapiDocument } from "../support/large-openapi.ts";
import { McpClient } from "../support/mcp-client.ts";

const index = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;

const listingJsonBudget = 800_000_000;

const accountsIndex = `import { accountRouter, defineApp, defineProvider, object, router, secrets, string } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
const write = JSON.stringify;
let written = 0;
JSON.stringify = function (...args: Parameters<typeof write>) {
  const text: string | undefined = write.apply(JSON, args);
  written += text?.length ?? 0;
  if (written > ${listingJsonBudget})
    throw new Error("The listing wrote " + written + " characters of JSON, over its budget of ${listingJsonBudget}.");
  return text;
} as typeof JSON.stringify;
const service = defineProvider({
  name: "Expandable service",
  auth: { key: secrets({ label: "Key", fields: object({ token: string({ minLength: 1 }) }) }) },
});
export default defineApp(
  { user: { accounts: { service: service.many() } } },
  async ({ user, cache, fetch, signal }) => {
    written = 0;
    return {
      tools: router(
        await accountRouter(
          user?.accounts.service ?? [],
          (account) => liveOpenapiRouter({ ...configuration, cache, fetch, signal, account }),
          { signal },
        ),
      ),
    };
  },
);`;
const linkedAccounts = 3;

const prose = "Returns the service’s “state” — café → ✅ or 🔴.";

const asciiConfiguration = (origin: string) =>
  JSON.stringify({
    source: { document: largeOpenapiDocument(origin, 1000, prose) },
    allowedOrigin: origin,
    securitySchemes: {},
    methods: {},
    oauth: [],
  }).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const wideIndex = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
// The tools of the Kanji 日本 API, which provider.ts names.
import "./provider.ts";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;
const wideProvider = `export const provider = { name: "Kanji 日本 API", headers: { "X-Note": "東京" } };\n`;

const expandableResources = 300;
const expandableOperations = 700;
const pageChars = 16 * 1024 * 1024;

const JsonSchemaDocument = Schema.Record(Schema.String, Schema.Json);
const ListedTool = Schema.Struct({
  name: Schema.String,
  inputSchema: JsonSchemaDocument,
  outputSchema: Schema.optional(JsonSchemaDocument),
});
const ToolPage = Schema.Struct({
  items: Schema.Array(ListedTool),
  next: Schema.optional(Schema.String),
});
const ToolIndex = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
const AccountsTool = Schema.Struct({
  name: Schema.String,
  inputSchema: Schema.Struct({
    anyOf: Schema.Array(
      Schema.Struct({
        properties: Schema.Struct({
          accountId: Schema.Struct({ enum: Schema.optional(Schema.Array(Schema.String)) }),
        }),
      }),
    ),
  }),
  outputSchema: Schema.optional(JsonSchemaDocument),
});
const AccountsToolPage = Schema.Struct({ items: Schema.Array(AccountsTool) });
const SearchResult = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });

const referenced = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) referenced(item, found);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/"))
        found.add(decodeURIComponent(item.slice("#/$defs/".length)));
      else referenced(item, found);
  return found;
};
const ownDefinitions = (schema: typeof JsonSchemaDocument.Type | undefined) => {
  const definitions = schema?.$defs;
  const names =
    typeof definitions === "object" && definitions !== null && !Array.isArray(definitions)
      ? Object.keys(definitions)
      : [];
  for (const name of referenced(schema)) expect(names).toContain(name);
  return names;
};

layer(HostedLive, { excludeTestServices: true })("Large OpenAPI app", (it) => {
  it.effect(
    scenarios.largeOpenapiExpandableApp.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            mcp = yield* McpClient;
          const origin = (yield* Target).metadata.origin;
          const configuration = JSON.stringify({
            source: {
              document: expandableOpenapiDocument(
                origin,
                expandableResources,
                expandableOperations,
              ),
            },
            allowedOrigin: origin,
            securitySchemes: {},
            methods: {},
            oauth: [],
          });
          yield* evidence.json("expandable-openapi-source.json", { bytes: configuration.length });

          const prefix = `/api/organizations/${actors.organization.id}/apps`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: `Expandable OpenAPI ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: index },
              { path: "openapi.json", content: configuration },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );

          const first = yield* api.request(actors.owner, "GET", `${path}/tools`);
          const firstText = JSON.stringify(first.body);
          yield* evidence.json("expandable-openapi-first-page.json", {
            status: first.status,
            characters: firstText.length,
            body: first.status === 200 ? undefined : first.body,
          });
          expect(first.status, firstText.slice(0, 2000)).toBe(200);
          expect(firstText.length).toBeLessThanOrEqual(pageChars);
          const page = yield* body(ToolPage, first);
          expect(page.items.length).toBeGreaterThan(1);
          expect(page.items.length).toBeLessThan(expandableOperations);
          expect(page.next).toBeDefined();
          const resources = page.items.filter((tool) => tool.name.startsWith("resources."));
          expect(resources.length).toBeGreaterThan(0);
          for (const tool of resources)
            expect(ownDefinitions(tool.outputSchema)).toHaveLength(expandableResources);

          const listed = yield* body(
            ToolIndex,
            yield* api.request(actors.owner, "GET", `${path}/tools/index`),
          );
          expect(listed.items).toHaveLength(expandableOperations + 1);

          const last = page.items.at(-1)?.name ?? "";
          const paged = page.items.map((tool) => tool.name);
          let next = page.next;
          while (next !== undefined) {
            expect(paged.length).toBeLessThanOrEqual(expandableOperations + 1);
            const response = yield* api.request(
              actors.owner,
              "GET",
              `${path}/tools?cursor=${encodeURIComponent(next)}`,
            );
            const text = JSON.stringify(response.body);
            expect(response.status, text.slice(0, 2000)).toBe(200);
            expect(text.length).toBeLessThanOrEqual(pageChars);
            const following = yield* body(ToolPage, response);
            expect(following.items.length).toBeGreaterThan(0);
            const previous = paged.at(-1) ?? "";
            for (const tool of following.items) expect(tool.name > previous).toBe(true);
            paged.push(...following.items.map((tool) => tool.name));
            next = following.next;
          }
          yield* evidence.json("expandable-openapi-pages.json", { tools: paged.length });
          expect(new Set(paged).size).toBe(paged.length);
          expect([...paged].sort()).toEqual(listed.items.map((tool) => tool.name).sort());

          const lastTool =
            listed.items
              .map((tool) => tool.name)
              .filter((name) => name.startsWith("resources."))
              .sort()
              .at(-1) ?? "";
          expect(lastTool > last).toBe(true);
          const described = yield* api.request(
            actors.owner,
            "GET",
            `${path}/tools/${encodeURIComponent(lastTool)}`,
          );
          expect(described.status, JSON.stringify(described.body).slice(0, 2000)).toBe(200);
          expect(ownDefinitions((yield* body(ListedTool, described)).outputSchema)).toHaveLength(
            expandableResources,
          );

          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Expandable OpenAPI",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(key.key, "expandable-openapi", {
            organization: actors.organization.id,
          });
          const searched = yield* client.use("Search the expandable app", (client, signal) =>
            client.callTool(
              {
                name: "search",
                arguments: { namespace: app.slug, query: "getResource137View1" },
              },
              undefined,
              { signal },
            ),
          );
          yield* evidence.json("expandable-openapi-search.json", searched.structuredContent);
          const found = yield* Schema.decodeUnknownEffect(SearchResult)(searched.structuredContent);
          expect(
            found.items.some(
              (item) =>
                item.path.includes(JSON.stringify(app.slug)) &&
                item.path.endsWith(".getResource137View1"),
            ),
            JSON.stringify(found.items.map((item) => item.path)),
          ).toBe(true);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 360_000 },
  );

  it.effect(
    scenarios.largeOpenapiAccountsApp.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const origin = (yield* Target).metadata.origin;
          const configuration = JSON.stringify({
            source: {
              document: expandableOpenapiDocument(
                origin,
                expandableResources,
                expandableOperations,
              ),
            },
            allowedOrigin: origin,
            securitySchemes: {},
            methods: {},
            oauth: [],
          });
          const organization = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${organization}/apps/deploy`, {
            name: `Expandable accounts ${randomUUID().slice(0, 8)}`,
            files: [
              { path: "index.ts", content: accountsIndex },
              { path: "openapi.json", content: configuration },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${organization}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );

          const accounts: string[] = [];
          for (let index = 0; index < linkedAccounts; index++) {
            const started = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "user", "service"),
              {},
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const connection = (yield* body(Schema.Struct({ id: Schema.String }), started)).id;
            const submitted = yield* api.request(
              actors.owner,
              "POST",
              `${organization}/connections/${connection}/submit`,
              { method: "key", label: `Key ${index + 1}`, fields: { token: `key-${index + 1}` } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            accounts.push((yield* body(Schema.Struct({ id: Schema.String }), submitted)).id);
          }

          const started = Date.now();
          const first = yield* api.request(actors.owner, "GET", `${path}/tools`);
          const firstText = JSON.stringify(first.body);
          yield* evidence.json("expandable-accounts-first-page.json", {
            status: first.status,
            characters: firstText.length,
            milliseconds: Date.now() - started,
            body: first.status === 200 ? undefined : first.body,
          });
          expect(first.status, firstText.slice(0, 2000)).toBe(200);
          expect(firstText.length).toBeLessThanOrEqual(pageChars);
          const page = yield* body(AccountsToolPage, first);
          const resources = page.items.filter((tool) => tool.name.startsWith("resources."));
          expect(resources.length).toBeGreaterThan(0);
          for (const tool of resources) {
            const branches = tool.inputSchema.anyOf;
            expect(branches).toHaveLength(1);
            expect([...(branches[0]?.properties.accountId.enum ?? [])].sort()).toEqual(
              [...accounts].sort(),
            );
            expect(ownDefinitions(tool.outputSchema)).toHaveLength(expandableResources);
          }

          const listed = yield* body(
            ToolIndex,
            yield* api.request(actors.owner, "GET", `${path}/tools/index`),
          );
          expect(listed.items).toHaveLength(expandableOperations + 1);
          expect(new Set(listed.items.map((tool) => tool.name)).size).toBe(listed.items.length);
        }),
      ),
    { timeout: 240_000 },
  );

  it.effect(scenarios.largeOpenapiApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const origin = (yield* Target).metadata.origin;
        const configuration = JSON.stringify(
          {
            source: { document: largeOpenapiDocument(origin, 377) },
            allowedOrigin: origin,
            securitySchemes: {},
            methods: {},
            oauth: [],
          },
          null,
          2,
        );
        yield* evidence.json("large-openapi-source.json", { bytes: configuration.length });
        expect(configuration.length).toBeGreaterThan(11_000_000);

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Large OpenAPI ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: index },
            { path: "openapi.json", content: configuration },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "service.health",
          kind: "query",
          input: {},
        });
        yield* evidence.json("large-openapi-call.json", {
          status: called.status,
          body: called.body,
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("ok") }))(
            called.body,
          ),
        ).toEqual({ status: "ok" });
      }),
    ),
  );

  it.effect(scenarios.largeOpenapiAsciiApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const origin = (yield* Target).metadata.origin;
        const configuration = asciiConfiguration(origin);
        yield* evidence.json("large-openapi-ascii-source.json", { bytes: configuration.length });
        expect(configuration.length).toBeGreaterThan(13_600_000);
        expect(configuration).not.toMatch(/[\u0080-\uffff]/);

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Large ASCII OpenAPI ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: index },
            { path: "openapi.json", content: configuration },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "service.health",
          kind: "query",
          input: {},
        });
        yield* evidence.json("large-openapi-ascii-call.json", {
          status: called.status,
          body: called.body,
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("ok") }))(
            called.body,
          ),
        ).toEqual({ status: "ok" });
      }),
    ),
  );

  it.effect(scenarios.largeOpenapiWideSourceApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const origin = (yield* Target).metadata.origin;
        const configuration = asciiConfiguration(origin);
        expect(configuration.length).toBeGreaterThan(13_600_000);
        expect(configuration).not.toMatch(/[\u0080-\uffff]/);
        expect(wideIndex + wideProvider).toMatch(/[\u0100-\uffff]/);

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Large wide source OpenAPI ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: wideIndex },
            { path: "provider.ts", content: wideProvider },
            { path: "openapi.json", content: configuration },
            appsManifest,
          ],
        });
        yield* evidence.json("large-openapi-wide-source-deploy.json", {
          status: deployed.status,
          body: JSON.stringify(deployed.body).slice(0, 2000),
        });
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const source = yield* api.request(actors.owner, "GET", `${path}/source`);
        expect(source.status).toBe(200);
        const files = (yield* body(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          source,
        )).files;
        expect(files.find((file) => file.path === "provider.ts")?.content).toBe(wideProvider);
        expect(files.find((file) => file.path === "index.ts")?.content).toBe(wideIndex);
        expect(files.find((file) => file.path === "openapi.json")?.content === configuration).toBe(
          true,
        );

        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "service.health",
          kind: "query",
          input: {},
        });
        yield* evidence.json("large-openapi-wide-source-call.json", {
          status: called.status,
          body: called.body,
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("ok") }))(
            called.body,
          ),
        ).toEqual({ status: "ok" });
      }),
    ),
  );
});
