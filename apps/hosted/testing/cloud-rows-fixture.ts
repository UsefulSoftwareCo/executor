/**
 * Local-only writer for rows no public surface can produce, such as a token whose stored fields
 * were changed after issue. Applies parameterized statements to the managed Cloud's loopback
 * database in one transaction and prints each statement's rows. Never installed in the HTTP
 * server; scenarios must scope their statements to rows they created.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const Statements = Schema.NonEmptyArray(
  Schema.Struct({
    sql: Schema.NonEmptyString,
    params: Schema.optional(
      Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
    ),
  }),
);

const command = Command.make("cloud-rows-fixture", {
  configuration: Flag.String("configuration"),
  statements: Flag.String("statements"),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        const fs = yield* FileSystem.FileSystem;
        const configuration = yield* fs
          .readFileString(args.configuration)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ database: Schema.String })),
              ),
            ),
          );
        const database = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(
          Redacted.make(configuration.database),
        );
        const statements = yield* fs
          .readFileString(args.statements)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Statements))));
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const rows = yield* Effect.promise(async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const results: Array<ReadonlyArray<unknown>> = [];
            for (const statement of statements)
              results.push((await client.query(statement.sql, [...(statement.params ?? [])])).rows);
            await client.query("COMMIT");
            return results;
          } catch (cause) {
            await client.query("ROLLBACK");
            throw cause;
          } finally {
            client.release();
          }
        });
        yield* Console.log(JSON.stringify(rows));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
