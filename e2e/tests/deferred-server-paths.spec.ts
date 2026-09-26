/**
 * The API document and the Executor app generator load on first use. Concurrent reads get one
 * identical document, and the installed Executor app is generated from that same document.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";

const Document = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
  components: Schema.Struct({ securitySchemes: Schema.Record(Schema.String, Schema.Json) }),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Configuration = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Struct({ url: Schema.String }),
    securitySchemes: Schema.Record(Schema.String, Schema.Json),
  }),
);

layer(HostedLive, { excludeTestServices: true })("Deferred server paths", (it) => {
  it.effect(scenarios.deferredServerPaths.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        const origin = target.metadata.origin;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const anonymous = yield* api.session();
        const installed: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(installed, (id) =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${id}`),
          ).pipe(Effect.orDie),
        );

        // Read the document and install the Executor app together, so neither
        // request relies on the other having produced the document.
        const name = `Executor deferred ${randomUUID().slice(0, 8)}`;
        const [documents, install] = yield* Effect.all(
          [
            Effect.forEach([1, 2, 3], () => api.request(anonymous, "GET", "/openapi.json"), {
              concurrency: "unbounded",
            }),
            api.request(actors.owner, "POST", `${prefix}/apps/install`, {
              entry: `${origin}/openapi.json`,
              name,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(install.status).toBe(200);
        const app = yield* body(App, install);
        installed.push(app.id);

        for (const response of documents) expect(response.status).toBe(200);
        expect(new Set(documents.map((response) => JSON.stringify(response.body))).size).toBe(1);
        const [first] = documents;
        if (first === undefined) return yield* Effect.die("No API document response");
        const document = yield* body(Document, first);
        expect(Object.keys(document.paths)).toContain("/api/organizations/{organization}/apps");
        expect(Object.keys(document.components.securitySchemes)).toEqual(
          expect.arrayContaining(["browserSession", "oauth"]),
        );

        // The prepared Executor app was generated from the same document.
        const files = (yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/source`),
        )).files;
        const configurationFile = files.find((file) => file.path === "openapi.json");
        if (configurationFile === undefined)
          return yield* Effect.die("The prepared Executor app has no OpenAPI configuration");
        const configuration = yield* Schema.decodeUnknownEffect(Configuration)(
          configurationFile.content,
        );
        expect(configuration.source.url).toBe(`${origin}/openapi.json`);
        expect(configuration.securitySchemes).toEqual(document.components.securitySchemes);
      }),
    ),
  );
});
