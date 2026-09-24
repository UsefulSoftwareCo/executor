/** Component schemas are stored once per app and attached to a tool schema only when it is used. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { defineApp } from "apps";
import { createAppHandler, hostContext } from "apps/host";
import { openapiOperations } from "apps/openapi";
import { compileOpenApi, generateOpenApiApp } from "../src/implementation/openapi.ts";

const json = (schema: unknown) => ({ "application/json": { schema } });
const spec = {
  openapi: "3.1.0",
  servers: [{ url: "https://example.test" }],
  components: {
    schemas: {
      Node: {
        type: "object",
        properties: {
          label: { type: "string" },
          children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
          owner: { $ref: "#/components/schemas/User" },
        },
        required: ["label"],
        additionalProperties: false,
      },
      User: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      Unrelated: { type: "object", properties: { secret: { type: "string" } } },
    },
  },
  paths: {
    "/nodes": {
      post: {
        operationId: "createNode",
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/Node" }) },
        responses: { "200": { content: json({ $ref: "#/components/schemas/Node" }) } },
      },
      get: {
        operationId: "listNodes",
        responses: {
          "200": { content: json({ type: "array", items: { $ref: "#/components/schemas/Node" } }) },
        },
      },
    },
    "/users": {
      get: {
        operationId: "listUsers",
        responses: { "200": { content: json({ $ref: "#/components/schemas/User" }) } },
      },
    },
  },
};

const handlerFor = (options: Parameters<typeof openapiOperations>[0]) => {
  const handler = createAppHandler(defineApp({ accounts: {} }, () => openapiOperations(options)));
  const request = async (body: unknown) => {
    const response = await handler(
      new Request("https://app.test", { method: "POST", body: JSON.stringify(body) }),
      hostContext({}),
    );
    return response.json() as Promise<unknown>;
  };
  return {
    call: (tool: string, input: unknown) => request({ operation: "call", tool, input }),
    inspect: () => request({ operation: "inspect" }),
  };
};

const upstream = (seen: unknown[]) => async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  seen.push(request.method === "POST" ? await request.json() : request.url);
  return Response.json({ label: "ok" });
};

test("each reached component is stored once and operations keep references", async () => {
  const generated = await Effect.runPromise(generateOpenApiApp({ name: "Nodes" }, spec));
  const { operations, definitions } = generated.metadata;
  assert.deepEqual(Object.keys(definitions).sort(), ["Node", "User"]);
  const text = JSON.stringify(operations);
  assert.doesNotMatch(text, /"\$defs"/);
  assert.match(text, /"\$ref":"#\/\$defs\/Node"/);
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.equal(files.has("operations.json"), false);
  assert.equal(files.has("definitions.json"), false);
  assert.deepEqual(JSON.parse(files.get("openapi.json") ?? "").source.document, spec);
  assert.match(files.get("index.ts") ?? "", /liveOpenapiOperations/);
});

test("the runtime validates through shared recursive definitions", async () => {
  const metadata = await Effect.runPromise(compileOpenApi({ name: "Nodes" }, spec));
  const seen: unknown[] = [];
  const app = handlerFor({ ...metadata, fetch: upstream(seen) });
  const body = { label: "root", children: [{ label: "leaf", owner: { name: "Ada" } }] };
  assert.deepEqual(await app.call("mutations.createNode", { body }), {
    ok: true,
    value: { label: "ok" },
  });
  assert.deepEqual(seen, [body]);
  for (const invalid of [
    { label: "root", children: [{ label: 1 }] },
    { label: "root", children: [{ label: "leaf", owner: {} }] },
    { label: "root", extra: true },
  ]) {
    const result = await app.call("mutations.createNode", { body: invalid });
    assert.equal(outcome(result).ok, false);
  }
  assert.equal(seen.length, 1);
});

test("described tools attach only the definitions their schemas reach", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Nodes" },
      {
        ...spec,
        paths: {
          ...spec.paths,
          "/other": {
            get: {
              operationId: "other",
              responses: { "200": { content: json({ $ref: "#/components/schemas/Unrelated" }) } },
            },
          },
        },
      },
    ),
  );
  const { value: tools } = (await handlerFor({ ...metadata, fetch: upstream([]) }).inspect()) as {
    value: unknown;
  };
  const listed = new Map(
    Array.isArray(tools)
      ? tools.map((tool: { name: string; inputSchema: unknown; outputSchema?: unknown }) => [
          tool.name,
          tool,
        ])
      : [],
  );
  const definitionNames = (schema: unknown) =>
    Object.keys((schema as { $defs?: Record<string, unknown> } | undefined)?.$defs ?? {}).sort();
  assert.deepEqual(definitionNames(listed.get("queries.listUsers")?.outputSchema), ["User"]);
  assert.deepEqual(definitionNames(listed.get("queries.listNodes")?.outputSchema), [
    "Node",
    "User",
  ]);
  assert.deepEqual(definitionNames(listed.get("mutations.createNode")?.inputSchema), [
    "Node",
    "User",
  ]);
  assert.doesNotMatch(JSON.stringify(listed.get("queries.listNodes")), /Unrelated|secret/);
});

test("apps generated with inline $defs keep working without shared definitions", async () => {
  const metadata = await Effect.runPromise(compileOpenApi({ name: "Nodes" }, spec));
  // The earlier format: every schema carried the definitions it reached, and no definitions file.
  const inline = (schema: Record<string, unknown>) => ({ ...schema, $defs: metadata.definitions });
  const operations = metadata.operations.map((operation) => ({
    ...operation,
    input: inline(operation.input),
    ...(operation.outputSchema === undefined
      ? {}
      : { outputSchema: inline(operation.outputSchema) }),
  }));
  const seen: unknown[] = [];
  const app = handlerFor({
    operations: JSON.parse(JSON.stringify(operations)),
    methods: metadata.methods,
    oauth: metadata.oauth,
    fetch: upstream(seen),
  });
  const body = { label: "root", children: [{ label: "leaf" }] };
  assert.deepEqual(await app.call("mutations.createNode", { body }), {
    ok: true,
    value: { label: "ok" },
  });
  assert.equal(
    outcome(await app.call("mutations.createNode", { body: { label: "root", children: [{}] } })).ok,
    false,
  );
  assert.deepEqual(seen, [body]);
});

test("a failed schema conversion leaves no partial shared definition", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Partial" },
      {
        openapi: "3.1.0",
        servers: [{ url: "https://example.test" }],
        components: {
          schemas: {
            Wrapper: {
              type: "object",
              properties: {
                _tag: { const: "Bad" },
                inner: { $ref: "#/components/schemas/Remote" },
              },
              required: ["_tag"],
            },
            Remote: { $ref: "https://unsupported.test/schema" },
          },
        },
        paths: {
          "/items": {
            get: {
              operationId: "items",
              responses: {
                "200": { content: json({ type: "string" }) },
                "422": { content: json({ $ref: "#/components/schemas/Wrapper" }) },
              },
            },
          },
        },
      },
    ),
  );
  // The unsupported error declaration is skipped; its placeholder must not remain as `{}`.
  assert.deepEqual(metadata.operations[0]?.errorResponses, []);
  assert.deepEqual(metadata.definitions, {});
});

test("multipart bodies retain only their file shapes beside the converted input", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Upload" },
      {
        openapi: "3.1.0",
        servers: [{ url: "https://example.test" }],
        paths: {
          "/upload": {
            post: {
              operationId: "upload",
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      properties: {
                        file: { type: "string", format: "binary" },
                        note: { type: "string", description: "Only in the converted input." },
                      },
                    },
                    encoding: { note: { contentType: "text/plain" } },
                  },
                  "application/json": { schema: { type: "object" } },
                },
              },
              responses: { "204": {} },
            },
          },
        },
      },
    ),
  );
  assert.deepEqual(metadata.operations[0]?.request.requestBody?.content, {
    "multipart/form-data": {
      encoding: { note: { contentType: "text/plain" } },
      schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
    },
    "application/json": {},
  });
  assert.match(JSON.stringify(metadata.operations[0]?.input), /Only in the converted input/);
});

/** Narrow a JSON tool result for assertions. */
function outcome(value: unknown): { readonly ok?: unknown } {
  return typeof value === "object" && value !== null ? value : {};
}
