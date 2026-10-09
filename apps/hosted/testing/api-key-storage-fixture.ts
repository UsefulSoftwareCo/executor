/**
 * Local-only storage fault for one API key, by its ID. While installed, PostgreSQL fails every
 * update to that key's row, so verifying the key meets a real database error. Other keys and
 * parallel scenarios on the shared database are untouched. Never installed in the HTTP server.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { escapeIdentifier, escapeLiteral, Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const command = Command.make("api-key-storage-fixture", {
  configuration: Flag.String("configuration"),
  key: Flag.String("key"),
  fault: Flag.Literals("fault", ["install", "remove"]),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        // Better Auth key IDs; the bound keeps the function name within PostgreSQL's 63 bytes.
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
        // One statement string runs as one implicit transaction.
        yield* Effect.promise(() =>
          pool.query(
            args.fault === "install"
              ? `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN RAISE EXCEPTION 'Synthetic storage failure for an e2e API key'; END $$;
                 CREATE TRIGGER ${fault} BEFORE UPDATE ON apikey FOR EACH ROW
                 WHEN (OLD.id = ${escapeLiteral(args.key)}) EXECUTE FUNCTION ${fault}();`
              : `DROP FUNCTION IF EXISTS ${fault}() CASCADE`,
          ),
        );
        yield* Console.log(JSON.stringify({ fault: args.fault }));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
