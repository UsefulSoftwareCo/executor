/** Imported schemas retain their validation rules without expanding recursive references. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { jsonSchema } from "apps";
import type { JsonObject } from "@executor-js/sdk";
import { compileOpenApi } from "../src/implementation/openapi.ts";

const compile = async (schema: JsonObject, version = "3.1.0", schemas: JsonObject = {}) => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Schema fixture" },
      {
        openapi: version,
        servers: [{ url: "https://example.test" }],
        components: { schemas },
        paths: {
          "/items": {
            post: {
              operationId: "items",
              requestBody: { required: true, content: { "application/json": { schema } } },
              responses: { "204": {} },
            },
          },
        },
      },
    ),
  );
  const operation = metadata.operations[0];
  assert.ok(operation);
  return operation;
};

test("OpenAPI 3.0 nullable does not override enum or an exclusive bound", async () => {
  const enumeration = jsonSchema(
    (await compile({ type: "string", nullable: true, enum: ["ready"] }, "3.0.3")).input,
  );
  assert.deepEqual(enumeration.parse({ body: "ready" }), { body: "ready" });
  assert.throws(() => enumeration.parse({ body: null }));
  const bound = jsonSchema(
    (await compile({ type: "number", minimum: 2, exclusiveMinimum: true }, "3.0.3")).input,
  );
  assert.throws(() => bound.parse({ body: 2 }));
  assert.deepEqual(bound.parse({ body: 3 }), { body: 3 });
});

test("reference siblings follow the selected OpenAPI version", async () => {
  const schema = { $ref: "#/components/schemas/Label", minLength: 3 };
  const components = { Label: { type: "string" } };
  const old = jsonSchema((await compile(schema, "3.0.3", components)).input);
  assert.deepEqual(old.parse({ body: "x" }), { body: "x" });
  const modern = jsonSchema((await compile(schema, "3.1.0", components)).input);
  assert.throws(() => modern.parse({ body: "x" }));
  assert.deepEqual(modern.parse({ body: "long" }), { body: "long" });
  const ignoredSibling = jsonSchema(
    (
      await compile(
        {
          ...schema,
          allOf: [{ $ref: "https://unsupported.test/ignored" }],
        },
        "3.0.3",
        components,
      )
    ).input,
  );
  assert.deepEqual(ignoredSibling.parse({ body: "x" }), { body: "x" });
  const modernNullable = jsonSchema((await compile({ type: "string", nullable: true })).input);
  assert.throws(() => modernNullable.parse({ body: null }));
});

test("recursive components remain serializable and only reachable definitions are retained", async () => {
  const operation = await compile({ $ref: "#/components/schemas/Node" }, "3.1.0", {
    Node: {
      type: "object",
      properties: {
        value: { type: "string" },
        children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
      },
      required: ["value"],
      additionalProperties: false,
    },
    Unused: { $ref: "https://unsupported.test/schema" },
  });
  assert.doesNotMatch(JSON.stringify(operation), /Unused|unsupported.test/);
  const validator = jsonSchema(operation.input);
  const value = { body: { value: "root", children: [{ value: "leaf" }] } };
  assert.deepEqual(validator.parse(value), value);
  assert.throws(() => validator.parse({ body: { value: "root", children: [{ value: 1 }] } }));
});

test("oneOf, not, boolean schemas and literal references keep their meaning", async () => {
  const literal = { $ref: "https://example.test/data", nullable: true };
  const operation = await compile({
    type: "object",
    properties: {
      value: { oneOf: [{ type: "number" }, { type: "integer" }] },
      message: { type: "string", not: { const: "private" } },
      blocked: false,
      literal: { const: literal, default: literal, examples: [literal] },
    },
    required: ["value", "message", "literal"],
    additionalProperties: false,
  });
  const validator = jsonSchema(operation.input);
  const body = { value: 1.5, message: "public", literal };
  assert.deepEqual(validator.parse({ body }), { body });
  for (const change of [{ value: 1 }, { message: "private" }, { blocked: true }, { extra: true }])
    assert.throws(() => validator.parse({ body: { ...body, ...change } }));
  assert.throws(() => validator.parse({ body: { value: 1.5, literal } }));
  assert.match(JSON.stringify(operation.input), /https:\/\/example.test\/data/);
});

test("error references preserve sibling constraints and unsupported wrappers do not abort import", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Errors" },
      {
        openapi: "3.1.0",
        servers: [{ url: "https://example.test" }],
        components: {
          schemas: {
            Error: {
              type: "object",
              properties: { _tag: { const: "Rejected" }, message: { type: "string" } },
              required: ["_tag", "message"],
            },
            Errors: { anyOf: [{ $ref: "#/components/schemas/Error" }] },
          },
        },
        paths: {
          "/items": {
            get: {
              responses: {
                "200": {},
                "418": { $ref: "https://unsupported.test/response" },
                "422": {
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/Error",
                        properties: { message: { not: { const: "private" } } },
                      },
                    },
                  },
                },
                "423": {
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/Errors",
                        properties: { message: { not: { const: "private" } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ),
  );
  const errors = metadata.operations[0]?.errorResponses;
  assert.ok(errors);
  assert.deepEqual(
    errors.map((error) => error.status),
    [422, 423],
  );
  for (const error of errors) {
    const validator = jsonSchema(error.schema);
    const body = { _tag: "Rejected", message: "public" };
    assert.deepEqual(validator.parse(body), body);
    assert.throws(() => validator.parse({ ...body, message: "private" }));
  }
});

test("security keeps AND requirements, OR alternatives and anonymous access", async () => {
  const metadata = await Effect.runPromise(
    compileOpenApi(
      { name: "Security" },
      {
        openapi: "3.1.0",
        servers: [{ url: "https://example.test" }],
        components: {
          securitySchemes: {
            a: { type: "apiKey", in: "header", name: "X-A" },
            b: { type: "apiKey", in: "header", name: "X-B" },
          },
        },
        security: [{ a: [], b: [] }, { a: [] }, {}],
        paths: { "/items": { get: { responses: { "200": {} } } } },
      },
    ),
  );
  assert.deepEqual(metadata.operations[0]?.request.security.map(Object.keys), [
    ["a", "b"],
    ["a"],
    [],
  ]);
});
