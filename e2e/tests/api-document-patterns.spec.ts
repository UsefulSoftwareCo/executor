import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

const Document = Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Json) });
const json = (schema: object) => ({ content: { "application/json": { schema } } });

layer(TestLive, { excludeTestServices: true })("API document patterns", (it) => {
  it.effect(scenarios.apiDocumentPatterns.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const target = yield* Target;
        const local = target.metadata.target === "local";
        const session = yield* api.session();
        const response = yield* session.send(
          "GET",
          "/openapi.json",
          undefined,
          local ? { authorization: `Bearer ${Redacted.value(target.apiKey)}` } : {},
        );
        expect(response.status).toBe(200);
        const { paths } = yield* body(Document, response);
        const app = local ? "/v1/apps/{app}" : "/api/organizations/{organization}/apps/{app}";

        const Rename = Schema.Struct({
          patch: Schema.Struct({
            requestBody: Schema.Struct({
              content: Schema.Struct({
                "application/json": Schema.Struct({
                  schema: Schema.Struct({
                    properties: Schema.Struct({ name: Schema.Struct({ pattern: Schema.String }) }),
                  }),
                }),
              }),
            }),
          }),
        });
        const name = new RegExp(
          (yield* Schema.decodeUnknownEffect(Rename)(paths[`${app}/name`])).patch.requestBody
            .content["application/json"].schema.properties.name.pattern,
        );
        for (const valid of ["Clock", " Café 日本語 👨‍👩‍👧 "])
          expect(name.test(valid), valid).toBe(true);
        for (const invalid of ["", " ", "Two\nlines", "Zero\u0000Width", "\u200b\u200d"])
          expect(name.test(invalid), JSON.stringify(invalid)).toBe(false);
        const commit = { type: "string", pattern: "^[a-f0-9]{40}$" };
        expect(paths[`${app}/commits`]).toMatchObject({
          post: {
            requestBody: json({
              properties: { expected: local ? { anyOf: [commit, { type: "null" }] } : commit },
            }),
          },
        });
        if (local) return;
        expect(paths[`${app}/name`]).toMatchObject({
          patch: {
            parameters: expect.arrayContaining([
              expect.objectContaining({
                name: "organization",
                schema: expect.objectContaining({
                  anyOf: expect.arrayContaining([
                    expect.objectContaining({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
                  ]),
                }),
              }),
            ]),
          },
        });
      }),
    ),
  );
});
