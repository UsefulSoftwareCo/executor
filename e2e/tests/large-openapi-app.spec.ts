/**
 * An OpenAPI app whose document is larger than the biggest imported vendor API's builds within
 * the compiler's memory, and its tools call the API. The document is an indented JSON file, as
 * imported apps wrote it, so it is the size whose build exceeded the hosted compiler's memory.
 *
 * Imported apps write their document as compact JSON in ASCII. As large as the largest imported
 * vendor API's, with prose beyond Latin-1 in every operation, such a document builds and calls,
 * also beside source files whose text goes beyond Latin-1, such as a provider's display name.
 *
 * A document whose resources expand into one another, as Stripe's do, gives every tool all of
 * its definitions. Its catalog written tool by tool is larger than any string, yet it lists in
 * pages no larger than their bound.
 */
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
import { expandableOpenapiDocument, largeOpenapiDocument } from "../support/large-openapi.ts";
import { McpClient } from "../support/mcp-client.ts";

const index = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;

/** Prose with Latin-1, punctuation, symbols and an emoji, as vendor API descriptions use. */
const prose = "Returns the service’s “state” — café → ✅ or 🔴.";

/** The document's configuration as imported apps write it: compact, each non-ASCII character a `\u` escape. */
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

/** An entry like `index`, beside a provider module whose display name goes beyond Latin-1. */
const wideIndex = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
// The tools of the Kanji 日本 API, which provider.ts names.
import "./provider.ts";
export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;
const wideProvider = `export const provider = { name: "Kanji 日本 API", headers: { "X-Note": "東京" } };\n`;

/**
 * Three hundred resources that expand into one another, each about ten thousand characters of
 * definition, and 700 operations that each return one. Every tool's output schema reaches all
 * three hundred definitions, so the tools written out in full are about 2.2 billion characters:
 * more than a JavaScript string holds, whatever the host's memory. The document is about 3.5 MB,
 * and the app's catalog with each definition and each distinct `$defs` once about 5 million
 * characters, near Stripe's 6.8 million, so a deployed Worker holds about as much as Stripe's.
 */
const expandableResources = 300;
const expandableOperations = 700;
/** The most a page of the tool listing holds, in characters, unless its first tool alone is more. */
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
const SearchResult = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });

/** Every `#/$defs/` name a JSON value references, anywhere in it. */
const referenced = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) referenced(item, found);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/"))
        found.add(decodeURIComponent(item.slice("#/$defs/".length)));
      else referenced(item, found);
  return found;
};
/**
 * The definitions a resource's output schema holds, after checking it is complete on its own: every
 * reference anywhere in it names one of its own definitions.
 */
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

          // The listing evaluates the whole catalog. Each page stays within the page bound, and
          // each tool's schemas are complete on their own, as an agent reads them.
          const first = yield* api.request(actors.owner, "GET", `${path}/tools`);
          // The body as sent: the server writes it as `JSON.stringify` does, so encoding the parsed
          // body again gives back its text. Each page is encoded once: at 16 MB, another encoding
          // adds about a tenth to the walk.
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

          // The index names every tool.
          const listed = yield* body(
            ToolIndex,
            yield* api.request(actors.owner, "GET", `${path}/tools/index`),
          );
          expect(listed.items).toHaveLength(expandableOperations + 1);

          // Following `next` to the end lists every tool once, each page within the bound and
          // continuing after the page before it.
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

          // The last tool reads with its whole schema.
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

          // MCP search ranks the app's tools rather than reporting the app unavailable.
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
    // Following `next` reads about 140 pages of 16 MB, one after another. Self-host CI runs the
    // scenario in 25 to 58 seconds, but a busy runner took 0.68 seconds a page, about 110 seconds
    // in all. A deployed stage answers a page in 1.1 to 2.1 seconds, 1.55 at the median of 55 runs,
    // so the walk alone takes 2.5 to 5 minutes there.
    { timeout: 360_000 },
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

        // The call compiles the whole document, then sends the one operation the product answers.
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
        // Each character beyond ASCII is a `\u` escape, as the importer writes it.
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
        // Characters beyond Latin-1 in the other files: the host retains every server file's text
        // together, so these would otherwise widen the document's copy too.
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

        // The app's files read back exactly as deployed.
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
