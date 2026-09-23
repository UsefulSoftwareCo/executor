/** Imported tools retain useful response shapes all the way to agent discovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createAppHandler, hostContext } from "apps/host";
import { defineApp } from "apps";
import { openapiOperations } from "apps/openapi";
import { compileOpenApi } from "../src/implementation/openapi.ts";

test("OpenAPI success references, nullable results and empty responses reach inspection", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Example" },
      {
        openapi: "3.1.0",
        servers: [{ url: "https://example.test" }],
        components: {
          schemas: {
            Item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        },
        paths: {
          "/items": {
            get: {
              operationId: "items",
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: { type: "array", items: { $ref: "#/components/schemas/Item" } },
                    },
                  },
                },
                "204": {},
                "400": { content: { "application/json": { schema: { type: "boolean" } } } },
              },
            },
          },
          "/unknown": { get: { operationId: "unknown", responses: { "200": {} } } },
        },
      },
    ),
  );
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => openapiOperations(metadata)),
  );
  const response = await handler(
    new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({ operation: "inspect" }),
    }),
    hostContext({}),
  );
  const body: unknown = await response.json();
  assert.equal(response.status, 200);
  const encoded = JSON.stringify(body);
  assert.match(encoded, /outputSchema/);
  assert.match(encoded, /\$defs/);
  assert.match(encoded, /"null"/);
  assert.doesNotMatch(encoded, /"boolean"/);
  assert.equal(metadata.operations.find((op) => op.name === "unknown")?.outputSchema, undefined);
});
