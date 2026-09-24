/** Contract coverage for the pinned Effect reference-observer patch. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonSchema } from "effect";

test("Effect reports original references only in schema positions without changing conversion", () => {
  const literal = { $ref: "https://example.test/literal" };
  const schema = {
    properties: {
      value: { $ref: "#/components/schemas/Value", not: { $ref: "#/components/schemas/Excluded" } },
      data: {
        const: literal,
        default: literal,
        example: literal,
        examples: [literal],
        "x-data": literal,
      },
    },
    allOf: [{ $ref: "#/components/schemas/Base" }],
    unevaluatedItems: { $ref: "#/components/schemas/Item" },
    contentSchema: { $ref: "#/components/schemas/Content" },
    $defs: { Local: { $dynamicRef: "#node" } },
  };
  const original = structuredClone(schema);
  const references: string[] = [];
  const observed = JsonSchema.fromSchemaOpenApi3_1(schema, {
    onReference: (ref) => references.push(ref),
  });
  assert.deepEqual(observed, JsonSchema.fromSchemaOpenApi3_1(schema));
  assert.deepEqual(schema, original);
  assert.deepEqual(references.sort(), [
    "#/components/schemas/Base",
    "#/components/schemas/Content",
    "#/components/schemas/Excluded",
    "#/components/schemas/Item",
    "#/components/schemas/Value",
    "#node",
  ]);
});

test("Effect does not visit OpenAPI 3.0 reference siblings or annotation data", () => {
  const refs: string[] = [];
  const schema = {
    properties: { value: { $ref: "#/components/schemas/Value", allOf: [{ $ref: "ignored" }] } },
    example: { $ref: "literal" },
  };
  const observed = JsonSchema.fromSchemaOpenApi3_0(schema, {
    onReference: (ref) => refs.push(ref),
  });
  assert.deepEqual(refs, ["#/components/schemas/Value"]);
  assert.deepEqual(observed, JsonSchema.fromSchemaOpenApi3_0(schema));
});

test("reference observer failures propagate through both converters", () => {
  const error = new Error("Rejected reference");
  for (const convert of [JsonSchema.fromSchemaOpenApi3_0, JsonSchema.fromSchemaOpenApi3_1])
    assert.throws(
      () =>
        convert(
          { $ref: "#/components/schemas/Value" },
          {
            onReference() {
              throw error;
            },
          },
        ),
      (thrown) => thrown === error,
    );
});
