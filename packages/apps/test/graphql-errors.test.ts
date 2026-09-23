import { GraphqlError } from "apps/graphql";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { buildSchema, graphql } from "graphql";
import { graphqlToolsEffect } from "../src/implementation/graphql.ts";

test("valid GraphQL failures stay distinct from malformed responses and omit upstream contents", async () => {
  const schema = buildSchema(
    "type Thing { good: String, bad: String } type Query { thing: Thing }",
  );
  const privateValue = "synthetic-private-upstream-value";
  let reply: unknown = { data: { thing: { good: "ok", bad: null } } };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
    )(body);
    const result = input.query.includes("IntrospectionQuery")
      ? await graphql({ schema, source: input.query })
      : reply;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const tools = await Effect.runPromise(
      graphqlToolsEffect({ url: `http://127.0.0.1:${address.port}` }),
    );
    const tool = tools.query_thing;
    assert.ok(tool);
    assert.deepEqual(await Effect.runPromise(tool.run({}, {})), { good: "ok", bad: null });
    for (const data of [null, { thing: { good: "ok", bad: null } }]) {
      reply = { data, errors: [{ message: privateValue, extensions: { internal: privateValue } }] };
      await assert.rejects(Effect.runPromise(tool.run({}, {})), (error: unknown) => {
        assert.ok(Schema.is(GraphqlError)(error));
        assert.equal(error.reason, "execution");
        assert.equal(error.status, 200);
        assert.ok(!JSON.stringify(error).includes(privateValue));
        return true;
      });
    }
    reply = { data: "not an object" };
    await assert.rejects(
      Effect.runPromise(tool.run({}, {})),
      (error: unknown) => Schema.is(GraphqlError)(error) && error.reason === "invalid_response",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
