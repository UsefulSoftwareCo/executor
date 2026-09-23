import assert from "node:assert/strict";
import { test } from "node:test";
import { mutation, defineApp, jsonSchema, ValidationError } from "apps";
import { HostedTool, HostResponse } from "apps/contracts";
import { createAppHandler, hostContext } from "apps/host";
import { Schema } from "effect";

test("shared JSON Schema inputs retain metadata and validate only the selected tool", async () => {
  const document = {
    type: "object",
    properties: { value: { $ref: "#/$defs/value" } },
    required: ["value"],
    additionalProperties: false,
    $defs: {
      value: {
        oneOf: [
          { type: "integer", minimum: 1 },
          { type: "string", pattern: "^ok$" },
        ],
      },
    },
  };
  const unsupported = { type: "object", $ref: "#/$defs/missing" };
  // OpenAPI templates declare inputs outside the factory; custom apps may declare them inside it.
  const input = jsonSchema(document);
  let calls = 0;
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async (appContext) => ({
      mutations: {
        valid: mutation({ description: "Valid tool", input }, async (operationContext, value) => {
          const _context = { ...appContext, ...operationContext };

          calls++;
          return value;
        }),
        unsupported: mutation(
          { description: "Unsupported input", input: jsonSchema(unsupported) },
          async (_operationContext, _input) => {
            calls++;
            return {};
          },
        ),
      },
    })),
  );
  const dispatch = async (command: unknown) => {
    const response = await handler(
      new Request("https://app.test/dispatch", {
        method: "POST",
        body: JSON.stringify(command),
      }),
      hostContext({}),
    );
    return Schema.decodeUnknownSync(HostResponse)(await response.json());
  };
  const catalog = await dispatch({ operation: "inspect" });
  assert.equal(catalog.ok, true);
  assert.deepEqual(
    Schema.decodeUnknownSync(Schema.Array(HostedTool))(catalog.value).map(
      (tool) => tool.inputSchema,
    ),
    [document, unsupported],
  );
  assert.equal(calls, 0);

  for (const tool of ["mutations.valid", "mutations.unsupported"]) {
    const result = await dispatch({ operation: "call", tool, input: { value: 0 } });
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "HostInputInvalid");
  }
  assert.equal(calls, 0);
  for (const value of [1, "ok"]) {
    assert.deepEqual(
      await dispatch({ operation: "call", tool: "mutations.valid", input: { value } }),
      {
        ok: true,
        value: { value },
      },
    );
  }
  assert.equal(calls, 2);
  assert.deepEqual(input.parse({ value: "ok" }), { value: "ok" });
  assert.throws(() => input.parse({ value: 0 }), ValidationError);
  assert.throws(() => input.parse({ value: 1, extra: true }), ValidationError);
});
