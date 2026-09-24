/** Declared API error bodies reach tool callers with their optional recovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { defineApp } from "apps";
import { createAppHandler, hostContext } from "apps/host";
import { openapiOperations } from "apps/openapi";
import { BuildMemoryExceeded } from "@executor-js/sdk/core";
import { compileOpenApi } from "../src/implementation/openapi.ts";

const secret = "synthetic-private-recovery-detail";
const recovery = { action: "Reload the record.", instructions: "Read the current revision first." };

// An error schema that allows extra fields, like many third-party APIs.
const permissive = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/fail": {
      get: {
        operationId: "fail",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: {} } } },
          "422": {
            description: "Conflict",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    _tag: { type: "string", enum: ["Conflict"] },
                    message: { type: "string" },
                  },
                  required: ["_tag", "message"],
                },
              },
            },
          },
        },
      },
    },
  },
};

async function call(spec: unknown, body: unknown) {
  const metadata = await Effect.runPromise(compileOpenApi({ name: "Errors" }, spec));
  const handler = createAppHandler(
    defineApp({ accounts: {} }, () =>
      openapiOperations({ ...metadata, fetch: async () => Response.json(body, { status: 422 }) }),
    ),
  );
  const response = await handler(
    new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({ operation: "call", tool: "queries.fail", input: {} }),
    }),
    hostContext({}),
  );
  const result: unknown = await response.json();
  return result;
}

test("a valid body recovery is returned with the declared error and extra keys are dropped", async () => {
  const result = await call(permissive, {
    _tag: "Conflict",
    message: "The record changed.",
    recovery: { ...recovery, private: secret },
  });
  assert.deepEqual(result, {
    ok: false,
    error: {
      _tag: "OpenapiResponseError",
      code: "Conflict",
      status: 422,
      message: "The record changed.",
      recovery,
    },
  });
});

test("an absent or malformed recovery keeps the declared error without recovery", async () => {
  for (const malformed of [
    undefined,
    secret,
    42,
    null,
    { action: "", instructions: recovery.instructions },
    { action: recovery.action },
    { action: recovery.action, instructions: 42 },
    { action: "x".repeat(1025), instructions: recovery.instructions },
    { action: recovery.action, instructions: "x".repeat(4097) },
  ]) {
    const result = await call(permissive, {
      _tag: "Conflict",
      message: "The record changed.",
      ...(malformed === undefined ? {} : { recovery: malformed }),
    });
    assert.deepEqual(
      result,
      {
        ok: false,
        error: {
          _tag: "OpenapiResponseError",
          code: "Conflict",
          status: 422,
          message: "The record changed.",
        },
      },
      JSON.stringify(malformed),
    );
  }
});

test("an Executor error imported from its published schema returns its curated recovery", async () => {
  const api = HttpApi.make("executor").add(
    HttpApiGroup.make("apps").add(
      HttpApiEndpoint.get("fail", "/fail", { error: [BuildMemoryExceeded] }).annotate(
        OpenApi.Identifier,
        "fail",
      ),
    ),
  );
  const spec = { ...OpenApi.fromApi(api), servers: [{ url: "https://executor.test" }] };
  const error = new BuildMemoryExceeded();
  const result = await call(spec, Schema.encodeSync(BuildMemoryExceeded)(error));
  assert.deepEqual(result, {
    ok: false,
    error: {
      _tag: "OpenapiResponseError",
      code: "BuildMemoryExceeded",
      status: 422,
      message: error.description,
      recovery: error.recovery,
    },
  });
});
