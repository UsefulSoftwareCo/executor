import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { introspect } from "./introspect";

describe("GraphQL large introspection compatibility", () => {
  it.effect("accepts a valid response larger than 32 MiB", () =>
    Effect.gen(function* () {
      const description = "x".repeat(33 * 1024 * 1024);
      const schema = {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            description,
            fields: [],
            inputFields: null,
            enumValues: null,
          },
        ],
      };
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: { __schema: schema } })),
        ),
      );
      const result = yield* introspect("https://example.test/graphql").pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)),
      );
      expect(result.__schema.queryType).toEqual({ name: "Query" });
      expect(result.__schema.types[0]?.description?.length).toBe(description.length);
    }),
  );
});
