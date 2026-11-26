import { PgClient } from "@effect/sql-pg";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Config, Console, Effect, Layer, Option } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { sqlAdapter } from "fumadb-effect/sql";
import { chat, ChatDB } from "./library.ts";

const program = Effect.gen(function* () {
  const url = yield* Config.option(Config.Redacted("DATABASE_URL"));
  const provider = Option.isSome(url) ? "postgresql" : "sqlite";
  const Database: Layer.Layer<SqlClient.SqlClient, Config.ConfigError | SqlError.SqlError> =
    Option.isSome(url)
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
