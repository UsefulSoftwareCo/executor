import { DurableObject } from "cloudflare:workers";
import { Effect, ManagedRuntime, Result, Schema, Semaphore } from "effect";
import * as Sqlite from "@effect/sql-sqlite-do/SqliteClient";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { DatabaseOperation, makeSqliteDatabase } from "../../src/index.ts";

const Input = Schema.Struct({
  write: Schema.Boolean,
  operations: Schema.Array(DatabaseOperation),
  rollback: Schema.optional(Schema.Boolean),
  metrics: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.Boolean),
});
const schema = {
  messages: {
    fields: {
      mailbox: { kind: "string" },
      score: { kind: "number", optional: true },
      read: { kind: "boolean", default: false },
    },
    indexes: [{ name: "by_mailbox", fields: ["mailbox", "score"] }],
  },
};
export class ExecutorAppData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.transactions = Semaphore.makeUnsafe(1);
    this.calls = new Map();
    this.instance = crypto.randomUUID();
    this.metrics = { rowsRead: 0, rowsWritten: 0, statements: 0 };
    const metrics = this.metrics;
    const measured = {
      sql: {
        exec(sql, ...bindings) {
          const cursor = ctx.storage.sql.exec(sql, ...bindings);
          return {
            columnNames: cursor.columnNames,
            *raw() {
              try {
                yield* cursor.raw();
              } finally {
                metrics.statements++;
                metrics.rowsRead += cursor.rowsRead;
                metrics.rowsWritten += cursor.rowsWritten;
              }
            },
          };
        },
      },
      transaction: (callback) => ctx.storage.transaction(callback),
    };
    this.runtime = ManagedRuntime.make(Sqlite.layer({ storage: measured }));
    this.ready = ctx.blockConcurrencyWhile(() =>
      this.runtime.runPromise(
        Effect.gen(function* () {
          return yield* SqlClient;
        }),
      ),
    );
  }
  async invoke(id, body, headers) {
    const controller = new AbortController();
    this.calls.set(id, controller);
    try {
      return await (
        await this.fetch(
          new Request("https://app.internal/data", {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }),
        )
      ).json();
    } finally {
      this.calls.delete(id);
    }
  }
  cancel(id) {
    this.calls.get(id)?.abort();
  }
  fetch(request) {
    return this.runtime.runPromise(
      this.transactions.withPermits(1)(
        Effect.tryPromise({ try: () => this.run(request), catch: (error) => error }),
      ),
      { signal: request.signal },
    );
  }
  async run(request) {
    const sql = await this.ready;
    this.metrics.rowsRead = 0;
    this.metrics.rowsWritten = 0;
    this.metrics.statements = 0;
    const db = await this.runtime.runPromise(makeSqliteDatabase({ sql, schema, crypto }));
    if (new URL(request.url).pathname === "/stats")
      return Response.json({ instance: this.instance });
    const input = Schema.decodeUnknownSync(Input)(await request.json());
    const result = await this.runtime.runPromise(
      db[input.write ? "mutate" : "read"]((session) =>
        Effect.gen(function* () {
          const values = yield* Effect.forEach(input.operations, (operation) =>
            session.execute(operation),
          );
          if (input.rollback) return yield* Effect.fail("rollback");
          return values;
        }),
      ).pipe(Effect.result),
      { signal: request.signal },
    );
    return Result.isSuccess(result)
      ? Response.json({
          ok: true,
          value: input.summary ? result.success.length : result.success,
          ...(input.metrics ? { metrics: this.metrics } : {}),
        })
      : Response.json({ ok: false }, { status: 409 });
  }
}
