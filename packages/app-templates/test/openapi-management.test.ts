/** Live management sources retain every operation's route and security when compiled. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { executorCloudApiDocument } from "../../../apps/hosted/cloud/src/contracts/api.ts";
import { executorSelfHostApiDocument } from "../../../apps/hosted/self-host/src/contracts/api.ts";
import { executorCatalogEntry } from "../../../apps/hosted/server/src/implementation/executor-app.ts";
import { compileOpenApi } from "../src/implementation/openapi.ts";

const Document = Schema.Struct({
  paths: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({
        operationId: Schema.String,
        security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
      }),
    ),
  ),
});

for (const [target, documentFor] of [
  ["Cloud", executorCloudApiDocument],
  ["self-host", executorSelfHostApiDocument],
] as const) {
  test(`${target} management compilation preserves all routes, security and streaming metadata`, async () => {
    const origin = "https://management.example.test";
    const document = documentFor(origin);
    const metadata = await Effect.runPromise(
      compileOpenApi(executorCatalogEntry(origin), document, { baseUrl: origin }),
    );
    const parsed = Schema.decodeUnknownSync(Document)(document);
    const expected = Object.entries(parsed.paths)
      .flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({
          name: operation.operationId.replace(/[^a-zA-Z0-9_]/g, "_"),
          method: method.toUpperCase(),
          path,
          security: operation.security.map((requirement) => Object.keys(requirement).sort()),
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(
      metadata.operations
        .map(({ name, method, path, request }) => ({
          name,
          method,
          path,
          security: request.security.map((requirement) => Object.keys(requirement).sort()),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      expected,
    );
    assert.equal(
      metadata.operations.find((operation) => operation.name === "appData_subscribe")?.streaming,
      true,
    );
  });
}
