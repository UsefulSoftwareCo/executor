/** Browsing reads names and descriptions; one tool's schemas are read only when it is described. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { CacheReply } from "@executor-js/app-cache";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { defineApp, object, query, string } from "../src/index.ts";
import { createAppHandler, hostContext } from "../src/host.ts";
import {
  HostResponse,
  inspectCommand,
  indexCommand,
  selectTools,
  type HostedTool,
} from "../src/contracts/host.ts";
import type { DynamicTools } from "../src/contracts/dynamic-tools.ts";
import { accountOperations } from "../src/implementation/account-operations.ts";
import { authorCache } from "../src/implementation/cache.ts";
import { isolatedCacheSession } from "../src/implementation/cache-session.ts";
import { catalogCache } from "../src/implementation/catalog-cache.ts";

const tool = (name: string): HostedTool => ({
  name,
  description: `Describe ${name}`,
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  outputSchema: { type: "object" },
  readOnly: name.startsWith("queries."),
});

/** Records every read so a test can prove which path served it. */
const source = (tools: readonly HostedTool[], native: boolean) => {
  const calls: string[] = [];
  const dynamic: DynamicTools = {
    list: () => Effect.sync(() => (calls.push("list"), tools)),
    resolve: () => Effect.succeed(undefined),
    ...(native
      ? {
          summaries: () =>
            Effect.sync(() => {
              calls.push("summaries");
              return tools.map(({ inputSchema: _input, outputSchema: _output, ...rest }) => rest);
            }),
          describe: (name: string) =>
            Effect.sync(() => {
              calls.push(`describe:${name}`);
              return tools.find((tool) => tool.name === name);
            }),
        }
      : {}),
  };
  return { calls, dynamic };
};

const inspect = async (dynamic: DynamicTools, command: unknown) => {
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async () => ({
      queries: {
        declared: query({ input: object({ id: string() }), output: string() }, async () => "ok"),
      },
      dynamicTools: dynamic,
    })),
  );
  const response = Schema.decodeUnknownSync(HostResponse)(
    await (
      await handler(
        new Request("https://synthetic.test/dispatch", {
          method: "POST",
          body: JSON.stringify(command),
        }),
        hostContext({}),
      )
    ).json(),
  );
  assert.equal(response.ok, true);
  return (response.ok ? response.value : []) as readonly Record<string, unknown>[];
};

test("the index omits schemas and reads source summaries instead of listing", async () => {
  const { calls, dynamic } = source([tool("queries.remote"), tool("mutations.write")], true);
  const index = await inspect(dynamic, indexCommand);
  assert.deepEqual(
    index.map((tool) => tool.name),
    ["queries.declared", "queries.remote", "mutations.write"],
  );
  assert.ok(index.every((tool) => !("inputSchema" in tool) && !("outputSchema" in tool)));
  assert.deepEqual(calls, ["summaries"]);
});

test("inspecting named tools describes only those, declared and dynamic", async () => {
  const { calls, dynamic } = source([tool("queries.remote"), tool("mutations.write")], true);
  const described = await inspect(dynamic, inspectCommand(["queries.declared", "mutations.write"]));
  assert.deepEqual(
    described.map((tool) => tool.name),
    ["queries.declared", "mutations.write"],
  );
  assert.ok(described.every((tool) => typeof tool.inputSchema === "object"));
  assert.deepEqual(calls, ["describe:mutations.write"]);
  const declaredOnly = await inspect(dynamic, inspectCommand(["queries.declared"]));
  assert.deepEqual(
    declaredOnly.map((tool) => tool.name),
    ["queries.declared"],
  );
  assert.deepEqual(calls, ["describe:mutations.write"]);
});

test("sources without summaries or describe are reduced from their list", async () => {
  const { calls, dynamic } = source([tool("queries.remote"), tool("mutations.write")], false);
  const index = await inspect(dynamic, indexCommand);
  assert.equal(index.length, 3);
  assert.ok(index.every((tool) => !("inputSchema" in tool)));
  const described = await inspect(dynamic, inspectCommand(["queries.remote"]));
  assert.deepEqual(
    described.map((tool) => tool.name),
    ["queries.remote"],
  );
  assert.equal(typeof described[0]?.inputSchema, "object");
  assert.deepEqual(calls, ["list", "list"]);
});

test("hosts reduce a full inspection from a build that ignores the tool filter", () => {
  const all = [tool("queries.a"), tool("queries.b"), tool("mutations.c")];
  assert.deepEqual(
    selectTools(["queries.b", "queries.missing"])(all).map((tool) => tool.name),
    ["queries.b"],
  );
  assert.equal(selectTools()(all), all);
});

/** A real SQLite cache behind the same session boundary isolated apps use. */
const memoryCache = () => {
  const db = new DatabaseSync(":memory:");
  const store = sqliteCache({
    sql: {
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    transactionSync: (work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  const session = isolatedCacheSession((command) =>
    Effect.runPromise(
      store("bld_test", command).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
        Effect.flatMap(Schema.encodeEffect(CacheReply)),
      ),
    ),
  );
  return authorCache(session.cache, {}, new AbortController().signal);
};

const Metadata = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
});
const Summary = Metadata.mapFields(({ inputSchema: _input, ...fields }) => fields);

test("catalog summaries are stored beside full pages and read without schemas", async () => {
  const cache = memoryCache();
  const upstream = Array.from({ length: 150 }, (_, index) => ({
    name: `tool${String(index).padStart(3, "0")}`,
    description: `Tool ${index}`,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  }));
  let loads = 0;
  const open = () =>
    Effect.runPromise(
      catalogCache({
        cache,
        prefix: ["tool-index-test"],
        schema: Metadata,
        summary: {
          schema: Summary,
          of: ({ inputSchema: _input, ...summary }) => summary,
        },
        load: () => Effect.sync(() => (loads++, upstream)),
      }),
    );
  const first = await open();
  const summaries = await Effect.runPromise(first.summaries());
  assert.equal(summaries.length, 150);
  assert.ok(summaries.every((summary) => !("inputSchema" in summary)));
  assert.deepEqual(summaries[42], { name: "tool042", description: "Tool 42" });
  assert.equal(loads, 1);
  // A later invocation reads the stored revision, including pages read in parallel.
  const second = await open();
  assert.deepEqual(
    (await Effect.runPromise(second.list())).map((tool) => tool.name),
    upstream.map((tool) => tool.name),
  );
  assert.deepEqual(await Effect.runPromise(second.resolve("tool149")), upstream[149]);
  assert.equal(await Effect.runPromise(second.resolve("missing")), undefined);
  assert.equal(loads, 1);
});

test("account merging keeps one summary per name and describes it like the full list", async () => {
  const tools = [tool("queries.shared"), tool("mutations.only")];
  const operations = await accountOperations(
    [{ id: "acc_a" }, { id: "acc_b" }],
    async (account) => ({
      dynamicTools: source(account.id === "acc_a" ? tools : tools.slice(0, 1), true).dynamic,
    }),
    { signal: new AbortController().signal },
  );
  const merged = "dynamicTools" in operations ? operations.dynamicTools : undefined;
  assert.ok(merged?.summaries !== undefined && merged.describe !== undefined);
  const summaries = await Effect.runPromise(merged.summaries());
  assert.deepEqual(
    summaries.map((summary) => summary.name),
    ["queries.shared", "mutations.only"],
  );
  assert.ok(summaries.every((summary) => !("inputSchema" in summary)));
  const listed = await Effect.runPromise(merged.list());
  assert.deepEqual(
    await Effect.runPromise(merged.describe("queries.shared")),
    listed.find((tool) => tool.name === "queries.shared"),
  );
  assert.equal(await Effect.runPromise(merged.describe("queries.missing")), undefined);
});
