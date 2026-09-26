/** Local custom OpenAPI imports generate app source; the source generators load on first use. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { importDefinition, importUpstream } from "../support/import-upstream.ts";

const Imported = Schema.Struct({
  id: Schema.String,
  skippedOperations: Schema.Array(Schema.Unknown),
});
const Configuration = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Struct({ url: Schema.String }),
    allowedOrigin: Schema.String,
  }),
);
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

layer(TestLive, { excludeTestServices: true })("Local custom import", (it) => {
  it.effect(scenarios.localCustomImport.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const target = yield* Target;
        const session = yield* api.session();
        const origin = yield* importUpstream;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const suffix = randomUUID().slice(0, 8);
        const imported: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(imported, (id) =>
            session.send("DELETE", `/v1/apps/${id}`, undefined, headers),
          ).pipe(Effect.orDie),
        );
        const importApp = (input: Record<string, unknown>) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              session,
              "POST",
              "/dashboard/api/apps/import",
              { source: input },
              headers,
            );
            expect(response.status).toBe(200);
            const app = yield* body(Imported, response);
            imported.push(app.id);
            const source = yield* body(
              Source,
              yield* session.send("GET", `/v1/apps/${app.id}/source`, undefined, headers),
            );
            return { app, files: source.files };
          });

        // Two imports start together, so neither relies on the other having loaded the generators.
        const imports = yield* Effect.forEach(
          ["first", "second"],
          (label) =>
            importApp({
              kind: "openapi",
              name: `Local OpenAPI ${label} ${suffix}`,
              url: `${origin}/openapi.json`,
            }),
          { concurrency: "unbounded" },
        );
        for (const { app, files } of imports) {
          expect(app.skippedOperations).toEqual([]);
          const file = files.find((candidate) => candidate.path === "openapi.json");
          if (file === undefined)
            return yield* Effect.die("The import has no OpenAPI configuration");
          // The compiled configuration pins the definition's server origin.
          const configuration = yield* Schema.decodeUnknownEffect(Configuration)(file.content);
          expect(configuration.source.url).toBe(`${origin}/openapi.json`);
          expect(configuration.allowedOrigin).toBe(importDefinition.serverOrigin);
        }
      }),
    ),
  );
});
