/** Declaration checks prevent an author from changing an operation's database authority through catalog placement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppHandler, hostContext } from "../src/host.ts";
import {
  query as defineQuery,
  mutation as defineMutation,
  defineApp,
  defineDatabase,
  object,
  string,
  table,
} from "../src/index.ts";
import { HostResponse } from "../src/contracts/host.ts";
import { Schema } from "effect";

const database = defineDatabase({ messages: table({ body: string() }) });
const query = defineQuery({ input: object({}), output: object({}) }, async () => ({}));
const mutation = defineMutation({ input: object({}), output: object({}) }, async () => ({}));
const inspect = async (app: unknown) =>
  Schema.decodeUnknownSync(HostResponse)(
    await (
      await createAppHandler(app)(
        new Request("https://test", {
          method: "POST",
          body: JSON.stringify({ operation: "inspect" }),
        }),
        hostContext({}),
      )
    ).json(),
  );

test("query and mutation names may match and keep distinct enforced routes", async () => {
  const app = defineApp({ accounts: {}, database }, async () => ({
    queries: { same: query },
    mutations: { same: mutation },
  }));
  const result = await inspect(app);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Inspection failed");
  const tools = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String, readOnly: Schema.Boolean })),
  )(result.value);
  assert.deepEqual(tools, [
    { name: "queries.same", readOnly: true },
    { name: "mutations.same", readOnly: false },
  ]);
});
test("JavaScript cannot put a mutation in the query catalog", async () => {
  // @ts-expect-error Deliberately bypass the author type at the runtime boundary.
  const app = defineApp({ accounts: {}, database }, async () => ({
    queries: {
      wrong: mutation,
    },
  }));
  assert.equal((await inspect(app)).ok, false);
});
test("authored tools are rejected rather than silently ignored", async () => {
  let ran = false;
  // @ts-expect-error Deliberately exercise JavaScript using the removed authoring surface.
  const app = defineApp({ accounts: {} }, async () => ({
    tools: {
      "queries.shadow": {
        description: "Invalid",
        input: object({}),
        run: async () => {
          ran = true;
          return {};
        },
      },
    },
  }));
  assert.equal((await inspect(app)).ok, false);
  assert.equal(ran, false);
});

test("external queries and mutations need no database and both enforce approval", async () => {
  const { query, mutation, withApproval } = await import("../src/index.ts");
  const { always } = await import("../src/approval.ts");
  let calls = 0;
  const read = query(
    { input: object({ value: string() }), output: string() },
    async ({ fetch }, input) => {
      const response = await fetch(`data:text/plain,${encodeURIComponent(input.value)}`);
      return response.text();
    },
  );
  const write = mutation({ input: object({}) }, async () => ++calls);
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => ({
      queries: { read, guarded: withApproval(read, always()) },
      mutations: { write, guarded: withApproval(write, always()) },
    })),
  );
  const invoke = async (operation: "query" | "mutate", name: string, input: unknown) =>
    Schema.decodeUnknownSync(HostResponse)(
      await (
        await handler(
          new Request("https://test", {
            method: "POST",
            body: JSON.stringify({ operation, name, input }),
          }),
          hostContext({}),
        )
      ).json(),
    );
  assert.deepEqual(await invoke("query", "read", { value: "external" }), {
    ok: true,
    value: "external",
  });
  assert.deepEqual(await invoke("mutate", "write", {}), { ok: true, value: 1 });
  for (const kind of ["query", "mutate"] as const) {
    const blocked = await invoke(kind, "guarded", { value: "blocked" });
    assert.equal(blocked.ok, false);
    if (blocked.ok) throw new Error("Approval was bypassed");
    const { HostToolApprovalRequired } = await import("../src/contracts/host.ts");
    assert.ok(Schema.is(HostToolApprovalRequired)(blocked.error));
  }
  assert.equal(calls, 1);
  assert.equal((await invoke("query", "write", {})).ok, false);
});

test("protocol helpers classify reads, default unknowns to mutation, and accept explicit overrides", async () => {
  const { protocolOperations } = await import("../src/implementation/protocol-operations.ts");
  const { Effect } = await import("effect");
  const native = (readOnly?: boolean) => ({
    description: "Fixture",
    input: Schema.Unknown,
    ...(readOnly === undefined ? {} : { readOnly }),
    run: () => Effect.succeed(null),
  });
  const operations = protocolOperations(
    {
      read: { ...native(true), input: Schema.Json },
      unknown: { ...native(), input: Schema.Json },
      override: { ...native(), input: Schema.Json },
    },
    { override: "query" },
  );
  const result = await inspect(defineApp({ accounts: {} }, async () => ({ ...operations })));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Inspection failed");
  const metadata = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String, readOnly: Schema.Boolean })),
  )(result.value);
  assert.deepEqual(metadata, [
    { name: "queries.read", readOnly: true },
    { name: "queries.override", readOnly: true },
    { name: "mutations.unknown", readOnly: false },
  ]);
});

test("storage is declared before factory evaluation", async () => {
  const app = defineApp({ accounts: {}, database }, async () => {
    throw new Error("Factory must not run for requirements");
  });
  const response = await createAppHandler(app)(
    new Request("https://test", {
      method: "POST",
      body: JSON.stringify({ operation: "requirements" }),
    }),
    hostContext({}),
  );
  const body = Schema.decodeUnknownSync(HostResponse)(await response.json());
  assert.equal(body.ok, true);
  if (!body.ok) throw new Error("Invalid declaration");
  assert.deepEqual(body.value, { accounts: {}, database: database.schema });
  // Operations no longer carry a second database declaration. Handler/requirements
  // mismatches are checked in context.types.ts; the HTTP regression checks storage authority.
});
