/** Spec-to-wire coverage through the portable app handler and its public fetch seam. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { defineApp } from "apps";
import { createAppHandler, hostContext } from "apps/host";
import { openapiOperations, type OpenapiToolsOptions } from "apps/openapi";
import { compileOpenApi } from "../src/implementation/openapi.ts";

const response = { "200": { description: "OK", content: { "application/json": { schema: {} } } } };
const document = (paths: unknown, components = {}, version = "3.1.0") => ({
  openapi: version,
  servers: [{ url: "https://{region}.example.test/v2", variables: { region: { default: "eu" } } }],
  paths,
  components,
});
async function fixture(
  spec: unknown,
  account?: OpenapiToolsOptions["account"],
  upstream?: typeof fetch,
) {
  const metadata = await Effect.runPromise(compileOpenApi({ name: "Wire fixture" }, spec));
  const received: Request[] = [];
  const handler = createAppHandler(
    defineApp({ accounts: {} }, () =>
      openapiOperations({
        ...metadata,
        ...(account === undefined ? {} : { account }),
        fetch: async (input, init) => {
          const request = new Request(input, init);
          received.push(request.clone());
          return upstream === undefined ? Response.json({ received: true }) : upstream(request);
        },
      }),
    ),
  );
  return {
    metadata,
    received,
    async call(tool: string, input: unknown, signal?: AbortSignal) {
      const response = await handler(
        new Request("https://app.test", {
          method: "POST",
          body: JSON.stringify({ operation: "call", tool, input }),
          ...(signal === undefined ? {} : { signal }),
        }),
        hostContext({}),
      );
      const result: unknown = await response.json();
      return result;
    },
  };
}

test("resolved 3.0 and 3.1 parameters preserve styles, cookies, content and server variables", async () => {
  for (const version of ["3.0.3", "3.1.0"]) {
    const f = await fixture(
      document(
        {
          "/items/{id}": {
            get: {
              operationId: "read",
              responses: response,
              parameters: [
                { $ref: "#/components/parameters/Id" },
                { name: "id", in: "query", schema: { type: "string" } },
                {
                  name: "filter",
                  in: "query",
                  style: "deepObject",
                  explode: true,
                  schema: { type: "object" },
                },
                {
                  name: "X-Meta",
                  in: "header",
                  style: "simple",
                  explode: true,
                  schema: { type: "object" },
                },
                { name: "theme", in: "cookie", schema: { type: "string" } },
                {
                  name: "data",
                  in: "query",
                  content: { "application/json": { schema: { type: "object" } } },
                },
              ],
            },
          },
        },
        {
          parameters: {
            Id: {
              name: "id",
              in: "path",
              required: true,
              style: "matrix",
              explode: true,
              schema: { type: "object" },
            },
          },
        },
        version,
      ),
    );
    const result = await f.call("queries.read", {
      path: { id: { role: "admin" } },
      query: { id: "separate", filter: { role: "editor" }, data: { n: 1 } },
      headers: { "X-Meta": { role: "reviewer" } },
      cookie: { theme: "dark" },
    });
    assert.equal(f.received.length, 1, JSON.stringify(result));
    const request = f.received[0];
    assert.ok(request);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://eu.example.test");
    assert.equal(url.pathname, "/v2/items/;role=admin");
    assert.equal(url.searchParams.get("id"), "separate");
    assert.equal(url.searchParams.get("filter[role]"), "editor");
    assert.equal(url.searchParams.get("data"), '{"n":1}');
    assert.equal(request.headers.get("X-Meta"), "role=reviewer");
    assert.equal(request.headers.get("cookie"), "theme=dark");
    assert.equal(request.redirect, "manual");
  }
});

test("JSON false, zero, empty string and null retain their wire values; alternate XML is explicit", async () => {
  const f = await fixture(
    document({
      "/body": {
        post: {
          operationId: "write",
          responses: response,
          requestBody: {
            required: true,
            content: {
              "application/vnd.example+json": { schema: {} },
              "application/xml": { schema: { type: "string" } },
            },
          },
        },
      },
    }),
  );
  for (const value of [false, 0, "", null, { n: 1 }]) {
    await f.call("mutations.write", { body: value });
    assert.equal(await f.received.at(-1)?.text(), JSON.stringify(value));
  }
  await f.call("mutations.write", { contentType: "application/xml", body: "<root/>" });
  assert.equal(await f.received.at(-1)?.text(), "<root/>");
  assert.equal(f.received.at(-1)?.headers.get("content-type"), "application/xml");
  const count = f.received.length;
  await f.call("mutations.write", { contentType: "application/xml", body: { bad: true } });
  assert.equal(f.received.length, count);
});

test("form encoding, multipart files and JSON parts use the declared media encoding", async () => {
  // OpenAPI 3.0 file fields reach the importer as 3.1 `contentMediaType` fields.
  for (const version of ["3.0.3", "3.1.0"]) {
    const f = await fixture(
      document(
        {
          "/form": {
            post: {
              operationId: "form",
              responses: response,
              requestBody: {
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: {
                      type: "object",
                      properties: { ids: { type: "array", items: { type: "string" } } },
                    },
                    encoding: { ids: { style: "pipeDelimited", explode: false } },
                  },
                },
              },
            },
          },
          "/multipart": {
            post: {
              operationId: "multipart",
              responses: response,
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      properties: {
                        file: { type: "string", format: "binary" },
                        meta: { type: "object" },
                      },
                    },
                    encoding: { meta: { contentType: "application/json" } },
                  },
                },
              },
            },
          },
        },
        {},
        version,
      ),
    );
    let result = await f.call("mutations.form", { body: { ids: ["a", "b"] } });
    assert.equal(f.received.length, 1, JSON.stringify(result));
    assert.equal(await f.received[0]?.text(), "ids=a|b");
    result = await f.call("mutations.multipart", { body: { file: "AAH/", meta: { n: 1 } } });
    assert.equal(f.received.length, 2, JSON.stringify(result));
    const form = await f.received[1]?.formData();
    assert.ok(form);
    const file = form.get("file"),
      meta = form.get("meta");
    assert.ok(file instanceof File);
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0, 1, 255]);
    assert.ok(meta instanceof File);
    assert.equal(meta.type, "application/json");
    assert.equal(await meta.text(), '{"n":1}');
  }
});

test("a Swagger 2.0 document is upgraded, including its host and form file uploads", async () => {
  const f = await fixture({
    swagger: "2.0",
    info: { title: "Legacy", version: "1" },
    host: "legacy.example.test",
    basePath: "/v1",
    schemes: ["https"],
    paths: {
      "/files": {
        post: {
          operationId: "upload",
          consumes: ["multipart/form-data"],
          parameters: [
            { in: "formData", name: "file", type: "file", required: true },
            { in: "formData", name: "note", type: "string", maxLength: 3 },
          ],
          responses: { "200": { description: "OK", schema: { type: "object" } } },
        },
      },
    },
  });
  const result = await f.call("mutations.upload", { body: { file: "AAH/", note: "hi" } });
  assert.equal(f.received.length, 1, JSON.stringify(result));
  const request = f.received[0];
  assert.ok(request);
  assert.equal(request.url, "https://legacy.example.test/v1/files");
  const form = await request.formData();
  const file = form.get("file");
  assert.ok(file instanceof File);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0, 1, 255]);
  assert.equal(form.get("note"), "hi");
  await f.call("mutations.upload", { body: { file: "AAH/", note: "long" } });
  assert.equal(f.received.length, 1);
});

test("selected credentials satisfy a whole alternative; public calls carry no credentials", async () => {
  const components = {
    securitySchemes: {
      a: { type: "apiKey", in: "header", name: "X-A" },
      b: { type: "apiKey", in: "cookie", name: "session" },
    },
  };
  const spec = document(
    {
      "/and": { get: { operationId: "and", security: [{ a: [], b: [] }], responses: response } },
      "/or": { get: { operationId: "or", security: [{ a: [] }, { b: [] }], responses: response } },
      "/public": { get: { operationId: "public", security: [], responses: response } },
    },
    components,
  );
  const f = await fixture(spec, {
    method: "a_and_b",
    fields: { a_token: "synthetic-a", b_token: "synthetic-b" },
  });
  await f.call("queries.and", {});
  await f.call("queries.or", {});
  await f.call("queries.public", {});
  assert.equal(f.received[0]?.headers.get("X-A"), "synthetic-a");
  assert.equal(f.received[0]?.headers.get("cookie"), "session=synthetic-b");
  assert.equal(f.received[1]?.headers.get("X-A"), "synthetic-a");
  assert.equal(f.received[1]?.headers.get("cookie"), null);
  assert.equal(f.received[2]?.headers.get("X-A"), null);
  assert.equal(f.received[2]?.headers.get("cookie"), null);
  assert.doesNotMatch(JSON.stringify(f.metadata), /synthetic-a|synthetic-b/);
  const incomplete = await fixture(spec, { method: "a", fields: { token: "synthetic-a" } });
  await incomplete.call("queries.and", {});
  assert.equal(incomplete.received.length, 0);
  const partial = await fixture(spec, { method: "a_and_b", fields: { a_token: "synthetic-a" } });
  await partial.call("queries.and", {});
  assert.equal(partial.received.length, 0);
  await partial.call("queries.or", {});
  assert.equal(partial.received[0]?.headers.get("X-A"), "synthetic-a");
  assert.equal(partial.received[0]?.headers.get("cookie"), null);
});

test("Basic and OAuth credentials are adapted without taking over their lifecycle", async () => {
  for (const [scheme, fields, expected] of [
    [
      { type: "http", scheme: "basic" },
      { username: "user", password: "pass" },
      "Basic dXNlcjpwYXNz",
    ],
    [{ type: "http", scheme: "bearer" }, { token: "synthetic" }, "Bearer synthetic"],
    [
      {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://example.test/authorize",
            tokenUrl: "https://example.test/token",
            scopes: { read: "Read" },
          },
        },
      },
      { access_token: "synthetic" },
      "Bearer synthetic",
    ],
  ] as const) {
    const f = await fixture(
      document(
        {
          "/auth": {
            get: { operationId: "auth", security: [{ credential: ["read"] }], responses: response },
          },
        },
        { securitySchemes: { credential: scheme } },
      ),
      { method: scheme.type === "oauth2" ? "credential" : "apiKey", fields },
    );
    const result = await f.call("queries.auth", {});
    assert.equal(f.received[0]?.headers.get("Authorization"), expected, JSON.stringify(result));
  }
});

test("binary request and response bytes survive the JSON tool boundary", async () => {
  const f = await fixture(
    document({
      "/file": {
        post: {
          operationId: "file",
          requestBody: {
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "200": {
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
    }),
    undefined,
    async () =>
      new Response(new Uint8Array([0, 1, 255]), {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  const result = await f.call("mutations.file", { body: "AAH/" });
  assert.deepEqual(result, {
    ok: true,
    value: { base64: "AAH/", contentType: "application/octet-stream" },
  });
  const request = f.received[0];
  assert.ok(request);
  assert.deepEqual([...new Uint8Array(await request.arrayBuffer())], [0, 1, 255]);
});

test("unsupported security alternatives do not remove a usable alternative or public operation", async () => {
  const f = await fixture(
    document(
      {
        "/public": {
          get: { operationId: "public", security: [{ mutual: [] }, {}], responses: response },
        },
      },
      { securitySchemes: { mutual: { type: "mutualTLS" } } },
    ),
  );
  await f.call("queries.public", {});
  assert.equal(f.received.length, 1);
});

test("redirects cannot forward selected credentials to another origin", async () => {
  let calls = 0;
  const f = await fixture(
    document(
      {
        "/redirect": {
          get: { operationId: "redirect", security: [{ key: [] }], responses: response },
        },
      },
      { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } } },
    ),
    { method: "apiKey", fields: { token: "synthetic" } },
    async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://other.test/" } });
    },
  );
  const result = await f.call("queries.redirect", {});
  assert.deepEqual(result, { ok: false, error: { _tag: "HostOperationFailed" } });
  assert.equal(calls, 1);
  assert.equal(f.received[0]?.redirect, "manual");
});

test("oversized successful bodies stop reading and fail the tool", async () => {
  let canceled = false;
  const f = await fixture(
    document({ "/large": { get: { operationId: "large", responses: response } } }),
    undefined,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16_777_217));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      ),
  );
  const result = await f.call("queries.large", {});
  assert.deepEqual(result, { ok: false, error: { _tag: "HostOperationFailed" } });
  assert.equal(canceled, true);
});

test("canceling a tool cancels its upstream fetch", { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let canceled = false;
  const f = await fixture(
    document({ "/slow": { get: { operationId: "slow", responses: response } } }),
    undefined,
    async (input) => {
      assert.ok(input instanceof Request);
      entered();
      return new Promise<Response>((_resolve, reject) =>
        input.signal.addEventListener(
          "abort",
          () => {
            canceled = true;
            reject(input.signal.reason);
          },
          { once: true },
        ),
      );
    },
  );
  const call = f.call("queries.slow", {}, controller.signal);
  await pending;
  controller.abort();
  await call.catch(() => undefined);
  assert.equal(canceled, true);
});

test("an operation with an unsupported body is skipped and the rest are kept", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Wire fixture" },
      document({
        "/empty": {
          post: { operationId: "sendNothing", requestBody: { content: {} }, responses: response },
        },
        "/json": {
          post: {
            operationId: "sendJson",
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: response,
          },
        },
      }),
    ),
  );
  assert.deepEqual(
    metadata.operations.map(({ name }) => name),
    ["sendJson"],
  );
  assert.deepEqual(metadata.skippedOperations, [
    { tool: "sendNothing", method: "POST", path: "/empty", reason: "request_body" },
  ]);
});

test("an import fails when every operation is skipped for different reasons", async () => {
  const exit = await Effect.runPromiseExit(
    compileOpenApi(
      { name: "Wire fixture" },
      document({
        "/empty": {
          post: { operationId: "sendNothing", requestBody: { content: {} }, responses: response },
        },
        relative: { get: { operationId: "badPath", responses: response } },
      }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(JSON.stringify(exit.cause), /no_supported_operations/);
});

/** A Google-style resource name that may span path segments. */
const reserved = document({
  "/{name}": {
    get: {
      operationId: "getRecord",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          allowReserved: true,
          schema: { type: "string" },
        },
      ],
      responses: response,
    },
  },
  "/{parent}/smartNotes:list": {
    get: {
      operationId: "listNotes",
      parameters: [
        {
          name: "parent",
          in: "path",
          required: true,
          allowReserved: true,
          schema: { type: "string" },
        },
      ],
      responses: response,
    },
  },
  "/users/{id}/posts": {
    get: {
      operationId: "listPosts",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: response,
    },
  },
});

test("an allowReserved path value keeps its slashes and the operation's fixed path", async () => {
  const f = await fixture(reserved);
  await f.call("queries.getRecord", { path: { name: "conferenceRecords/abc" } });
  await f.call("queries.listNotes", { path: { parent: "conferenceRecords/abc/participants/x" } });
  assert.deepEqual(
    f.received.map(({ url }) => url),
    [
      "https://eu.example.test/v2/conferenceRecords/abc",
      "https://eu.example.test/v2/conferenceRecords/abc/participants/x/smartNotes:list",
    ],
  );
});

test("an allowReserved path value cannot leave the operation path", async () => {
  const f = await fixture(reserved);
  for (const name of [
    "../x",
    "a/../../b",
    "./x",
    "a/.",
    "%2e%2e/x",
    "a/%2E%2E/b",
    "a%2fb",
    "a%5c..",
    "%252e%252e",
    "a?b",
    "a#b",
    "/x",
    "//evil.example/x",
    "a\\b",
    "a//b",
    "a/",
    "",
  ]) {
    const result = await f.call("queries.getRecord", { path: { name } });
    assert.deepEqual(result, { ok: false, error: { _tag: "HostOperationFailed" } }, name);
  }
  assert.deepEqual(f.received, []);
});

test("a path value without allowReserved is escaped and cannot add dot segments", async () => {
  const f = await fixture(reserved);
  await f.call("queries.listPosts", { path: { id: "a/b?c#d" } });
  assert.deepEqual(
    f.received.map(({ url }) => url),
    ["https://eu.example.test/v2/users/a%2Fb%3Fc%23d/posts"],
  );
  for (const id of ["..", "."]) {
    const result = await f.call("queries.listPosts", { path: { id } });
    assert.deepEqual(result, { ok: false, error: { _tag: "HostOperationFailed" } }, id);
  }
  assert.equal(f.received.length, 1);
});

test("serialized empty path segments cannot turn an item tool into its collection endpoint", async () => {
  for (const [schema, input] of [
    [{ type: "string" }, ""],
    [{ type: "array", items: { type: "string" } }, []],
    [{ type: "array", items: { type: "string" } }, [""]],
    [{ type: "object", additionalProperties: { type: "string" } }, {}],
  ]) {
    const f = await fixture(
      document({
        "/projects/p/keys/{id}": {
          delete: {
            operationId: "removeKey",
            responses: response,
            parameters: [{ name: "id", in: "path", required: true, schema }],
          },
        },
      }),
    );
    const result = await f.call("mutations.removeKey", { path: { id: input } });
    assert.deepEqual(
      result,
      { ok: false, error: { _tag: "HostOperationFailed" } },
      JSON.stringify(input),
    );
    assert.equal(f.received.length, 0);
  }
});

test("path matching retains literal encoded braces, reserved names and static punctuation", async () => {
  const f = await fixture(
    document({
      "/%7Bid%7D/executorPathParameter/records.v1/{id}": {
        get: {
          operationId: "literal",
          responses: response,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    }),
  );
  const result = await f.call("queries.literal", { path: { id: "a/b" } });
  assert.deepEqual(result, { ok: true, value: { received: true } });
  assert.equal(
    f.received[0]?.url,
    "https://eu.example.test/v2/%7Bid%7D/executorPathParameter/records.v1/a%2Fb",
  );
});
