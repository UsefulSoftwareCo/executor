/**
 * An OpenAPI app whose document is larger than the biggest imported vendor API's builds within
 * the compiler's memory, and its tools call the API. The document is an indented JSON file, as
 * imported apps wrote it, so it is the size whose build exceeded the hosted compiler's memory.
 *
 * Imported apps write their document as compact JSON in ASCII. As large as the largest imported
 * vendor API's, with prose beyond Latin-1 in every operation, such a document builds and calls,
 * also beside source files whose text goes beyond Latin-1, such as a provider's display name.
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
import { largeOpenapiDocument } from "../support/large-openapi.ts";

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

layer(HostedLive, { excludeTestServices: true })("Large OpenAPI app", (it) => {
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
