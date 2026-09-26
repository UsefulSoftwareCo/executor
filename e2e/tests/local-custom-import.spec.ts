/** Local custom MCP imports generate app source; the source generators load on first use. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { publicTemplateUpstream } from "../support/template-upstream.ts";

const Imported = Schema.Struct({ id: Schema.String });
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
        const origin = yield* publicTemplateUpstream;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const suffix = randomUUID().slice(0, 8);
        const imported: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(imported, (id) =>
            session.send("DELETE", `/v1/apps/${id}`, undefined, headers),
          ).pipe(Effect.orDie),
        );
        const importApp = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              session,
              "POST",
              "/dashboard/api/apps/import",
              { source: { kind: "mcp", name, url: `${origin}/mcp` } },
              headers,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(Imported, response);
            imported.push(app.id);
            return (yield* body(
              Source,
              yield* session.send("GET", `/v1/apps/${app.id}/source`, undefined, headers),
            )).files;
          });

        // Two imports start together, so neither relies on the other having loaded the generators.
        const imports = yield* Effect.forEach(
          ["first", "second"],
          (label) => importApp(`Local MCP ${label} ${suffix}`),
          { concurrency: "unbounded" },
        );
        for (const files of imports) {
          const index = files.find((file) => file.path === "index.ts");
          if (index === undefined) return yield* Effect.die("The import has no entry point");
          expect(index.content).toContain(JSON.stringify(`${origin}/mcp`));
          // A public server needs no account, so no provider is generated.
          expect(files.map((file) => file.path)).not.toContain("provider.ts");
        }
      }),
    ),
  );
});
