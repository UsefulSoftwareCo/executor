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

  it.effect("wraps NDJSON response schemas in an array (the shape invoke returns)", () =>
    Effect.gen(function* () {
      // NDJSON endpoints (e.g. Vercel's runtime-logs) declare the schema of
      // ONE line under application/stream+json; the invoke path returns an
      // array of parsed lines, so the advertised output schema must be that
      // array, not the per-line object.
      const lineSchema = {
        type: "object",
        properties: { level: { type: "string" }, message: { type: "string" } },
      };
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Logs", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/logs": {
              get: {
                operationId: "getRuntimeLogs",
                responses: {
                  "200": {
                    description: "Log lines",
                    content: { "application/stream+json": { schema: lineSchema } },
                  },
                },
              },
            },
          },
        }),
      );

      const result = yield* extract(doc);
      const operation = result.operations.find((op) => op.operationId === "getRuntimeLogs");
      const outputSchema = Option.getOrUndefined(operation!.outputSchema) as Record<
        string,
        unknown
      >;
      expect(outputSchema.type).toBe("array");
      expect(outputSchema.items).toEqual(lineSchema);
      // The caveats (truncation, raw-text fallback) ride the description into
      // the compiled TypeScript preview.
      expect(outputSchema.description).toContain("NDJSON");

      // The binding keeps the RAW per-line schema: invoke decodes the body
      // per line, and the serve path re-derives the array wrap from the
      // content type.
      const responseBody = Option.getOrUndefined(operation!.responseBody);
      expect(responseBody?.contentType).toBe("application/stream+json");
      expect(Option.getOrUndefined(responseBody!.schema)).toEqual(lineSchema);
    }),
  );

  it.effect("leaves plain JSON response schemas unwrapped", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Plain", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/thing": {
              get: {
                operationId: "getThing",
                responses: {
                  "200": {
                    description: "One thing",
                    content: {
                      "application/json": {
                        schema: { type: "object", properties: { id: { type: "string" } } },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );

      const result = yield* extract(doc);
      const operation = result.operations.find((op) => op.operationId === "getThing");
      const outputSchema = Option.getOrUndefined(operation!.outputSchema) as Record<
        string,
        unknown
      >;
      expect(outputSchema.type).toBe("object");
    }),
  );
});

describe("OpenAPI extract required scopes", () => {
  it.effect("preserves requirement alternatives and applies document-level inheritance", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Scoped", version: "1.0.0" },
          servers: [{ url: "https://api.example.com" }],
          // Document default: everything needs base.read unless overridden.
          security: [{ oauth: ["base.read"] }],
          paths: {
            "/files": {
              get: {
                operationId: "listFiles",
                // Two ALTERNATIVE requirement objects (an OR): a caller needs
                // files.read, OR files.admin — never both at once. Alternatives
                // must survive extraction separately, not as a union.
                security: [{ oauth: ["files.read"] }, { oauth: ["files.admin"] }],
                responses: { "200": { description: "ok" } },
              },
            },
            "/mixed": {
              get: {
                operationId: "mixedSchemes",
                // One requirement object spanning two schemes: an AND — its
                // scopes union into a single alternative.
                security: [{ oauth: ["a.read"], other: ["b.read"] }],
                responses: { "200": { description: "ok" } },
              },
            },
            "/inherited": {
              get: {
                operationId: "inheritedOp",
                // No security key: inherits the document default.
                responses: { "200": { description: "ok" } },
              },
            },
            "/public": {
              get: {
                operationId: "publicPing",
                // Explicit []: auth disabled — no scopes, despite the default.
                security: [],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      );

      const result = yield* extract(doc);
      const byId = (id: string) => result.operations.find((op) => op.operationId === id);

      expect(byId("listFiles")?.requiredScopeAlternatives).toEqual([
        ["files.read"],
        ["files.admin"],
      ]);
      expect(byId("mixedSchemes")?.requiredScopeAlternatives).toEqual([["a.read", "b.read"]]);
      expect(byId("inheritedOp")?.requiredScopeAlternatives).toEqual([["base.read"]]);
      expect(
        byId("publicPing")?.requiredScopeAlternatives,
        "explicit security: [] disables auth, so no scopes",
      ).toBeUndefined();
    }),
  );
});
