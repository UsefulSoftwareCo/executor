/** The published API document keeps the string patterns that the server enforces on requests. */
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
        // Local serves the document to programmatic callers: its API key and no browser Origin.
        const response = yield* session.send(
          "GET",
          "/openapi.json",
          undefined,
          local ? { authorization: `Bearer ${Redacted.value(target.apiKey)}` } : {},
        );
        expect(response.status).toBe(200);
        const { paths } = yield* body(Document, response);
        const app = local ? "/v1/apps/{app}" : "/api/organizations/{organization}/apps/{app}";

        // App names need a visible character; an expected commit is a full SHA-1.
        expect(paths[`${app}/name`]).toMatchObject({
          patch: { requestBody: json({ properties: { name: { pattern: "\\S" } } }) },
        });
        const commit = { type: "string", pattern: "^[a-f0-9]{40}$" };
        expect(paths[`${app}/commits`]).toMatchObject({
          post: {
            requestBody: json({
              properties: { expected: local ? { anyOf: [commit, { type: "null" }] } : commit },
            }),
          },
        });
        if (local) return;
        // Hosted routes accept an organization ID or its slug.
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
