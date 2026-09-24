/** A remote caller's deadline must roll back locally even when no cancel RPC arrives. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Sqlite from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeSqliteDatabase } from "@executor-js/app-data";
import { createAppHandler, hostContext } from "apps/host";
import { defineApp, defineDatabase, mutation, object, string, table } from "apps";
import { HostResponse, WorkflowFailure, type HostContext } from "apps/contracts";
type AppStorage = NonNullable<HostContext["storage"]>;

test(
  "an expired remote mutation rolls back its row and replay receipt without caller cancellation",
  { timeout: 5000 },
  async () => {
    const runtime = ManagedRuntime.make(Sqlite.layer({ filename: ":memory:" }));
    try {
      const database = defineDatabase({ messages: table({ body: string() }) });
      const db = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) =>
          makeSqliteDatabase({ sql, schema: database.schema, crypto }),
        ),
      );
      const storage: AppStorage = {
        read: (_schema, work) => db.read(work),
        mutate: (_schema, work) => db.mutate(work),
      };
      let writes = 0;
      const handler = createAppHandler(
        defineApp(
          { accounts: {}, database },
          {
            mutations: {
              held: mutation({ input: object({}) }, async (ctx) => {
                await ctx.db.messages.insert({ body: "must roll back" });
                writes++;
                await new Promise((resolve) => setTimeout(resolve, 500));
                return null;
              }),
            },
          },
        ),
      );
      const context: HostContext = {
        ...hostContext({}),
        storage,
        deadline: Date.now() + 200,
        replay: { key: "deadline-step", fingerprint: "deadline-input" },
      };
      const result = Schema.decodeUnknownSync(HostResponse)(
        await (
          await handler(
            new Request("https://app.internal/dispatch", {
              method: "POST",
              body: JSON.stringify({ operation: "mutate", name: "held", input: {} }),
            }),
            context,
          )
        ).json(),
      );
      assert.equal(writes, 1, "the mutation must reach its write before the deadline");
      assert.equal(result.ok, false, "the remote host must enforce the deadline itself");
      assert.ok(Schema.is(WorkflowFailure)(result.error));
      assert.equal(result.error.reason, "engine");
      assert.equal(result.error.retryable, true);
      const rows = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) => sql`SELECT body FROM app_rows`),
      );
      const receipts = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) => sql`SELECT id FROM app_mutation_receipts`),
      );
      assert.deepEqual(rows, []);
      assert.deepEqual(receipts, []);
      const expired = Schema.decodeUnknownSync(HostResponse)(
        await (
          await handler(
            new Request("https://app.internal/dispatch", {
              method: "POST",
              body: JSON.stringify({ operation: "mutate", name: "held", input: {} }),
            }),
            { ...context, deadline: Date.now() - 1 },
          )
        ).json(),
      );
      assert.equal(expired.ok, false);
      assert.ok(Schema.is(WorkflowFailure)(expired.error));
      assert.equal(expired.error.reason, "engine");
      assert.equal(writes, 1, "queue time must not restart an expired deadline");
      const retried = Schema.decodeUnknownSync(HostResponse)(
        await (
          await handler(
            new Request("https://app.internal/dispatch", {
              method: "POST",
              body: JSON.stringify({ operation: "mutate", name: "held", input: {} }),
            }),
            { ...context, deadline: Date.now() + 2000 },
          )
        ).json(),
      );
      assert.equal(retried.ok, true);
      assert.equal(writes, 2, "a later attempt may execute the rolled-back replay key");
      const committed = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) => sql`SELECT body FROM app_rows`),
      );
      const saved = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) => sql`SELECT id FROM app_mutation_receipts`),
      );
      assert.equal(committed.length, 1);
      assert.equal(saved.length, 1);
    } finally {
      await runtime.dispose();
    }
  },
);
