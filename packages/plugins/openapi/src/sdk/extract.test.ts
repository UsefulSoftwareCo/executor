import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { extract } from "./extract";
import { parse } from "./parse";

describe("OpenAPI extract response bodies", () => {
  it.effect("extracts success responses declared with the wildcard 2XX status key", () =>
    Effect.gen(function* () {
      // OpenAPI allows wildcard status keys like `2XX`; Microsoft Graph
      // declares every success response this way (no numeric 200/201 keys at
      // all), so the extractor must treat them as success responses.
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Wildcard", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/files/{id}": {
              get: {
                operationId: "downloadFile",
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                  "2XX": {
                    description: "File contents",
                    content: {
                      "application/octet-stream": {
                        schema: { type: "string", format: "binary" },
                      },
                    },
                  },
                  "4XX": { description: "error" },
                },
              },
            },
          },
        }),
      );

      const result = yield* extract(doc);
      const operation = result.operations.find((op) => op.operationId === "downloadFile");
      expect(operation).toBeDefined();

      const responseBody = Option.getOrUndefined(operation!.responseBody);
      expect(responseBody).toBeDefined();
      expect(responseBody!.contentType).toBe("application/octet-stream");
      expect(Option.getOrUndefined(responseBody!.fileHint)?.kind).toBe("binaryResponse");
    }),
  );

  it.effect("prefers exact 2xx status codes over the 2XX wildcard", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Wildcard", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/things": {
              get: {
                operationId: "listThings",
                responses: {
                  "2XX": {
                    description: "Generic success",
                    content: {
                      "text/plain": { schema: { type: "string" } },
                    },
                  },
                  "200": {
                    description: "Listed",
                    content: {
                      "application/json": { schema: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        }),
      );

      const result = yield* extract(doc);
      const operation = result.operations.find((op) => op.operationId === "listThings");
      const responseBody = Option.getOrUndefined(operation!.responseBody);
      expect(responseBody?.contentType).toBe("application/json");
    }),
  );
});
