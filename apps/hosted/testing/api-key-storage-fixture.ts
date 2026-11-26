import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { escapeIdentifier, escapeLiteral, Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const command = Command.make("api-key-storage-fixture", {
  configuration: Flag.String("configuration"),
  key: Flag.String("key"),
  fault: Flag.Literals("fault", ["install", "slow", "remove"]),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        if (!/^[A-Za-z0-9]{16,48}$/.test(args.key))
          return yield* Effect.die("Expected an API key ID");
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
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const fault = escapeIdentifier(`e2e_api_key_fault_${args.key}`);
        const writes = escapeIdentifier(`e2e_api_key_count_${args.key}`);
        const key = escapeLiteral(args.key);
        const trigger = `CREATE TRIGGER ${fault} BEFORE UPDATE ON apikey FOR EACH ROW
          WHEN (OLD.id = ${key}) EXECUTE FUNCTION ${fault}();`;
        const statements = {
          install: `UPDATE apikey SET "lastRequest" = NULL WHERE id = ${key};
            CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'Synthetic storage failure for an e2e API key'; END $$;
            ${trigger}`,
          slow: `UPDATE apikey SET "lastRequest" = NULL WHERE id = ${key};
            CREATE SEQUENCE ${writes};
            CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM nextval('${writes}'); PERFORM pg_sleep(1); RETURN NEW; END $$;
            ${trigger}`,
          remove: `DROP FUNCTION IF EXISTS ${fault}() CASCADE`,
        };
        yield* Effect.promise(() => pool.query(statements[args.fault]));
        if (args.fault !== "remove")
          return yield* Console.log(JSON.stringify({ fault: args.fault }));
        const present = yield* Effect.promise(() =>
          pool.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [
            writes,
          ]),
        );
        const counted = present.rows[0]?.present
          ? yield* Effect.promise(() =>
              pool.query<{ writes: number }>(
                `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS writes FROM ${writes};`,
              ),
            )
          : undefined;
        yield* Effect.promise(() => pool.query(`DROP SEQUENCE IF EXISTS ${writes}`));
        const count = counted?.rows[0]?.writes;
        yield* Console.log(
          JSON.stringify(
            count === undefined ? { fault: args.fault } : { fault: args.fault, writes: count },
          ),
        );
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
