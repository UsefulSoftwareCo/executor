/**
 * The consumer side: bind an adapter, provide a driver layer, migrate, use.
 *
 * Run with a database, for example:
 *   DATABASE_URL=postgresql://user:password@localhost:5434/postgresql node --experimental-strip-types playground/fumadb-effect/consumer.ts
 * or without one (in-memory SQLite):
 *   node --experimental-strip-types playground/fumadb-effect/consumer.ts
 */
import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Config, Console, Effect, Layer, Option } from "effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { chat, ChatDB } from "./library.ts";

const program = Effect.gen(function* () {
  const url = yield* Config.option(Config.Redacted("DATABASE_URL"));
  const provider = Option.isSome(url) ? "postgresql" : "sqlite";
  const Database = Option.isSome(url)
    ? PgClient.layer({ url: url.value })
    : SqliteClient.layer({ filename: ":memory:" });

  const client = ChatDB.names.prefix("chat_").client(sqlAdapter({ provider }));
  const lib = chat(client);

  yield* Effect.gen(function* () {
    const migrator = yield* client.createMigrator;
    const result = yield* migrator.migrateToLatest();
    yield* Console.log(Option.getOrElse(result.sql, () => ""));
    yield* result.execute;
    yield* lib.post("fuma", "hello");
    yield* lib.post("fuma", "world");
    yield* Console.log(yield* lib.timeline());
  }).pipe(Effect.provide(Database));
});

Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.empty))).catch((error) => {
  console.error(error);
  process.exit(1);
});
