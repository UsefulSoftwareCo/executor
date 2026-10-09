/**
 * Local-only probe of one object's database connections, by the name the Cloud Worker gives
 * them. Counts them, or terminates them to stand in for a connection the server drops. It can
 * also stall the next connection the object opens inside PostgreSQL's login, before the server
 * reports it ready, to stand in for a connection attempt that hangs. Never installed in the HTTP
 * server.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

/**
 * A PostgreSQL 17 login trigger. The first login under an armed name claims the row and sleeps;
 * logins meanwhile skip the locked row, and later ones find it disarmed. Every other login
 * only reads the table.
 */
const installStall = `
CREATE SCHEMA IF NOT EXISTS e2e_connect_stall;
CREATE TABLE IF NOT EXISTS e2e_connect_stall.armed (
  application_name text PRIMARY KEY,
  seconds double precision NOT NULL
);
CREATE OR REPLACE FUNCTION e2e_connect_stall.on_login() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE stall double precision;
BEGIN
  SELECT seconds INTO stall FROM e2e_connect_stall.armed
    WHERE application_name = current_setting('application_name') AND seconds > 0
    FOR UPDATE SKIP LOCKED;
  IF stall IS NOT NULL THEN
    UPDATE e2e_connect_stall.armed SET seconds = 0
      WHERE application_name = current_setting('application_name');
    PERFORM pg_sleep(stall);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'e2e_connect_stall') THEN
    CREATE EVENT TRIGGER e2e_connect_stall ON login EXECUTE FUNCTION e2e_connect_stall.on_login();
  END IF;
END $$;`;

const command = Command.make("database-connections-fixture", {
  configuration: Flag.String("configuration"),
  owner: Flag.String("owner"),
  terminate: Flag.Boolean("terminate").pipe(Flag.withDefault(false)),
  stallNextConnect: Flag.Int("stall-next-connect").pipe(Flag.optional),
  releaseStalls: Flag.Boolean("release-stalls").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        // Only one object's connections, so parallel scenarios on the shared database are untouched.
        if (!/^mcp [0-9a-f]{40,64}$/.test(args.owner))
          return yield* Effect.die("Expected an MCP session object's owner name");
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
        const name = `executor ${args.owner}`.slice(0, 63);
        const stall = args.stallNextConnect;
        if (Option.isSome(stall)) {
          yield* Effect.promise(() => pool.query(installStall));
          yield* Effect.promise(() =>
            pool.query(
              `INSERT INTO e2e_connect_stall.armed VALUES ($1, $2)
               ON CONFLICT (application_name) DO UPDATE SET seconds = excluded.seconds`,
              [name, stall.value],
            ),
          );
        }
        if (args.releaseStalls) {
          // A login still sleeping holds its claimed row; it is already disarmed, so skip it.
          yield* Effect.promise(() =>
            pool.query(
              `UPDATE e2e_connect_stall.armed SET seconds = 0 WHERE application_name IN (
                 SELECT application_name FROM e2e_connect_stall.armed
                 WHERE application_name = $1 FOR UPDATE SKIP LOCKED)`,
              [name],
            ),
          );
          yield* Effect.promise(() => pool.query("DROP EVENT TRIGGER IF EXISTS e2e_connect_stall"));
        }
        const result = yield* Effect.promise(() =>
          pool.query(
            args.terminate
              ? `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS connections
                 FROM pg_stat_activity WHERE application_name = $1`
              : `SELECT count(*)::int AS connections FROM pg_stat_activity WHERE application_name = $1`,
            [name],
          ),
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ connections: Schema.Number })]),
        )(result.rows);
        yield* Console.log(JSON.stringify(rows[0]));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
