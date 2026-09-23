/** Generated contracts are queried through the same author/host boundary as installed management tools. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { defineApp } from "apps";
import { createAppHandler, hostContext } from "apps/host";
import { frameworkQueries } from "../executor/framework.ts";
import { generateFrameworkReference } from "../../apps/scripts/reference.mjs";

const Result = Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown });
const Entry = Schema.Struct({
  symbol: Schema.String,
  signatures: Schema.Array(Schema.String),
  summary: Schema.String,
});
const Reference = Schema.Struct({ version: Schema.String, digest: Schema.String });
const Describe = Schema.Struct({
  reference: Reference,
  entry: Entry,
  types: Schema.Array(Schema.Struct({ symbol: Schema.String, definition: Schema.String })),
  examples: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});

test("search and describe expose checked return shapes, methods, examples and exact identities", async () => {
  const catalog = await generateFrameworkReference();
  const handler = createAppHandler(
    defineApp({ accounts: {} }, { queries: frameworkQueries(catalog) }),
  );
  const call = async (tool: string, input: unknown) => {
    const response = await handler(
      new Request("https://app.test", {
        method: "POST",
        body: JSON.stringify({ operation: "call", tool: `queries.${tool}`, input }),
      }),
      hostContext({}),
    );
    return { status: response.status, body: await response.json() };
  };
  const searched = await call("framework_search", { query: "insert row" });
  const search = Schema.decodeUnknownSync(
    Schema.Struct({
      reference: Reference,
      items: Schema.Array(Schema.Struct({ symbol: Schema.String })),
      remaining: Schema.Number,
    }),
  )(Schema.decodeUnknownSync(Result)(searched.body).value);
  assert(search.items.some((item) => item.symbol === "DatabaseTable.insert"));
  assert.match(search.reference.digest, /^[a-f0-9]{64}$/);
  const describe = async (symbol: string) =>
    Schema.decodeUnknownSync(Describe)(
      Schema.decodeUnknownSync(Result)(
        (await call("framework_describe", { symbol, ...search.reference })).body,
      ).value,
    );
  const insert = await describe("DatabaseTable.insert");
  assert(insert.entry.signatures.some((signature) => signature.includes("Promise<Row>")));
  assert.match(insert.entry.summary, /complete row/);
  assert(insert.types.some((type) => type.symbol === "DatabaseTable"));
  assert(insert.examples.some((example) => example.files.some((file) => file.path === "index.ts")));
  const hook = await describe("apps/react.useAppQuery");
  assert(
    hook.entry.signatures.some(
      (signature) =>
        signature.includes("data: A | undefined") && signature.includes("pending: boolean"),
    ),
  );
  const client = await describe("AppClient.mutate");
  assert(client.types.some((type) => type.symbol === "apps/client.OperationReference"));
  assert.notEqual(
    (await call("framework_describe", { symbol: "apps/react.useAppQuery", digest: "stale" }))
      .status,
    200,
  );
  assert.notEqual(
    (await call("framework_describe", { symbol: "apps/host.createAppHandler" })).status,
    200,
  );
  assert.notEqual((await call("framework_search", { offset: -1 })).status, 200);
});
