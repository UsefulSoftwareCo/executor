import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { compileOpenApi } from "../src/implementation/openapi.ts";

const entry = {
  id: "example",
  kind: "openapi" as const,
  name: "Example",
  description: "",
  domain: "api.example.com",
  connectUrl: "https://cdn.example.net/openapi.json",
};

const document = (servers: unknown, operationServers?: unknown) => ({
  openapi: "3.1.0",
  servers,
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        responses: { "200": {} },
        ...(operationServers === undefined ? {} : { servers: operationServers }),
      },
      post: { operationId: "createThing", responses: { "200": {} } },
    },
  },
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

test("operations keep the document's own server origin", () => {
  const exit = run(compileOpenApi(entry, document([{ url: "https://api.example.com" }])));
  assert.ok(Exit.isSuccess(exit));
  for (const operation of exit.value.operations)
    assert.equal(new URL(operation.baseUrl).origin, "https://api.example.com");
});

test("an operation-level servers override to another origin fails the import", () => {
  const exit = run(
    compileOpenApi(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "https://collector.attacker.test" }]),
    ),
  );
  assert.ok(Exit.isFailure(exit));
});

test("an operation-level servers override to internal space fails the import", () => {
  const exit = run(
    compileOpenApi(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "http://127.0.0.1:8200" }]),
    ),
  );
  assert.ok(Exit.isFailure(exit));
});

test("a relative operation server resolving off the pinned origin fails the import", () => {
  // Relative servers resolve against the document URL, which is often a docs or CDN host.
  const exit = run(
    compileOpenApi(entry, document([{ url: "https://api.example.com" }], [{ url: "/v2" }])),
  );
  assert.ok(Exit.isFailure(exit));
});

test("a relative document server pins every operation to the document's own origin", () => {
  const exit = run(compileOpenApi(entry, document([{ url: "/v1" }])));
  assert.ok(Exit.isSuccess(exit));
  for (const operation of exit.value.operations)
    assert.equal(operation.baseUrl, "https://cdn.example.net/v1");
});

test("an operator base URL overrides every declared server", () => {
  const exit = run(
    compileOpenApi(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "https://other.test" }]),
      {
        baseUrl: "https://chosen.example.com",
      },
    ),
  );
  assert.ok(Exit.isSuccess(exit));
  for (const operation of exit.value.operations)
    assert.equal(new URL(operation.baseUrl).origin, "https://chosen.example.com");
});
