import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { compileOpenApi, generateOpenApiApp } from "../src/implementation/openapi.ts";

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

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

test("operations keep the document's own server origin", async () => {
  const exit = await run(compileOpenApi(entry, document([{ url: "https://api.example.com" }])));
  assert.ok(Exit.isSuccess(exit));
  for (const operation of exit.value.operations)
    assert.equal(new URL(operation.baseUrl).origin, "https://api.example.com");
});

/** Every kept operation calls the pinned origin; the rest are reported as skipped. */
const assertOneOrigin = (
  exit: Exit.Exit<Effect.Success<ReturnType<typeof compileOpenApi>>, unknown>,
  origin: string,
  skipped: readonly string[],
) => {
  assert.ok(Exit.isSuccess(exit));
  assert.ok(exit.value.operations.length > 0);
  for (const operation of exit.value.operations)
    assert.equal(new URL(operation.baseUrl).origin, origin);
  assert.deepEqual(
    exit.value.skippedOperations.map(({ tool, reason }) => [tool, reason]),
    skipped.map((tool) => [tool, "multiple_hosts"]),
  );
};

test("an operation-level servers override to another origin is skipped", async () => {
  const exit = await run(
    compileOpenApi(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "https://collector.attacker.test" }]),
    ),
  );
  assertOneOrigin(exit, "https://api.example.com", ["listThings"]);
});

test("an operation-level servers override to internal space is skipped", async () => {
  const exit = await run(
    compileOpenApi(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "http://127.0.0.1:8200" }]),
    ),
  );
  assertOneOrigin(exit, "https://api.example.com", ["listThings"]);
});

test("a relative operation server resolving off the pinned origin is skipped", async () => {
  // Relative servers resolve against the document URL, which is often a docs or CDN host.
  const exit = await run(
    compileOpenApi(entry, document([{ url: "https://api.example.com" }], [{ url: "/v2" }])),
  );
  assertOneOrigin(exit, "https://api.example.com", ["listThings"]);
});

test("a document server that every operation overrides does not pin the origin", async () => {
  // Google's specs declare www.googleapis.com at the root and a service host on each operation.
  const service = [{ url: "https://service.example.com/" }];
  const exit = await run(
    compileOpenApi(entry, {
      openapi: "3.0.0",
      servers: [{ url: "https://www.example.com/" }],
      paths: {
        "/things": {
          get: { operationId: "listThings", servers: service, responses: { "200": {} } },
          post: { operationId: "createThing", servers: service, responses: { "200": {} } },
        },
      },
    }),
  );
  assertOneOrigin(exit, "https://service.example.com", []);
});

test("the origin most operations use is pinned over the document server", async () => {
  const api = [{ url: "https://api.example.com" }];
  const exit = await run(
    compileOpenApi(entry, {
      openapi: "3.1.0",
      servers: [{ url: "https://files.example.com" }],
      paths: {
        "/files": { post: { operationId: "uploadFile", responses: { "200": {} } } },
        "/things": {
          servers: api,
          get: { operationId: "listThings", responses: { "200": {} } },
          post: { operationId: "createThing", responses: { "200": {} } },
        },
        "/other": { get: { operationId: "getOther", responses: { "200": {} } } },
        "/more": { get: { operationId: "getMore", servers: api, responses: { "200": {} } } },
      },
    }),
  );
  assertOneOrigin(exit, "https://api.example.com", ["uploadFile", "getOther"]);
});

test("a tie is pinned to the document server, and a single outlier cannot pin even when first", async () => {
  // Stripe declares api.stripe.com; its file upload operations override it with files.stripe.com.
  const files = [{ url: "https://files.example.com" }];
  const tie = await run(
    compileOpenApi(entry, {
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/files": { post: { operationId: "uploadFile", servers: files, responses: { "200": {} } } },
        "/things": { get: { operationId: "listThings", responses: { "200": {} } } },
      },
    }),
  );
  assertOneOrigin(tie, "https://api.example.com", ["uploadFile"]);
  const outlier = await run(
    compileOpenApi(entry, {
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/files": { post: { operationId: "uploadFile", servers: files, responses: { "200": {} } } },
        "/things": {
          get: { operationId: "listThings", responses: { "200": {} } },
          post: { operationId: "createThing", responses: { "200": {} } },
        },
      },
    }),
  );
  assertOneOrigin(outlier, "https://api.example.com", ["uploadFile"]);
  assert.ok(Exit.isSuccess(outlier));
  assert.deepEqual(outlier.value.skippedOperations[0], {
    tool: "uploadFile",
    method: "POST",
    path: "/files",
    reason: "multiple_hosts",
  });
});

test("skipped operations are reported to the importer, not written into the source", async () => {
  const exit = await run(
    generateOpenApiApp(
      entry,
      document([{ url: "https://api.example.com" }], [{ url: "https://files.example.com" }]),
    ),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value.toolCount, 1);
  assert.deepEqual(exit.value.skippedOperations, [
    { tool: "listThings", method: "GET", path: "/things", reason: "multiple_hosts" },
  ]);
  assert.deepEqual(
    exit.value.files.map(({ path }) => path).filter((path) => path !== "package.json"),
    ["index.ts", "openapi.json"],
  );
  const index = exit.value.files.find(({ path }) => path === "index.ts");
  assert.doesNotMatch(index?.content ?? "", /skipped/i);
});

test("server variables use their defaults, including the document server's declaration", async () => {
  // Sentry declares the region on the document server and repeats the URL on one operation
  // without declaring the variable again.
  const exit = await run(
    compileOpenApi(entry, {
      openapi: "3.1.0",
      servers: [{ url: "https://{region}.example.com", variables: { region: { default: "us" } } }],
      paths: {
        "/things": {
          get: { operationId: "listThings", responses: { "200": {} } },
          post: {
            operationId: "createThing",
            servers: [{ url: "https://{region}.example.com" }],
            responses: { "200": {} },
          },
        },
      },
    }),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(
    exit.value.operations.map(({ baseUrl }) => baseUrl),
    ["https://us.example.com", "https://us.example.com"],
  );
});

test("an undeclared server variable is skipped, and fails the import when it is the only cause", async () => {
  const exit = await run(
    compileOpenApi(entry, document([{ url: "https://{tenant}.example.com" }])),
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(JSON.stringify(exit.cause), /server_url/);
});

test("a relative document server pins every operation to the document's own origin", async () => {
  const exit = await run(compileOpenApi(entry, document([{ url: "/v1" }])));
  assert.ok(Exit.isSuccess(exit));
  for (const operation of exit.value.operations)
    assert.equal(operation.baseUrl, "https://cdn.example.net/v1");
});

test("an operator base URL overrides every declared server", async () => {
  const exit = await run(
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
