import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

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

const installStatementStall = `
CREATE SCHEMA IF NOT EXISTS e2e_statement_stall;
CREATE TABLE IF NOT EXISTS e2e_statement_stall.armed (
  application_name text PRIMARY KEY,
  counter text NOT NULL,
  stall_at bigint NOT NULL
);
CREATE OR REPLACE FUNCTION e2e_statement_stall.on_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE armed e2e_statement_stall.armed;
BEGIN
  SELECT * INTO armed FROM e2e_statement_stall.armed
    WHERE application_name = current_setting('application_name');
  IF armed.counter IS NOT NULL AND nextval(armed.counter) = armed.stall_at THEN
    PERFORM pg_advisory_xact_lock(hashtext(armed.application_name));
  END IF;
  RETURN NULL;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'e2e_statement_stall_before') THEN
    CREATE TRIGGER e2e_statement_stall_before BEFORE UPDATE ON apikey
      FOR EACH STATEMENT EXECUTE FUNCTION e2e_statement_stall.on_update();
  END IF;
END $$;`;

const command = Command.make("database-connections-fixture", {
  configuration: Flag.String("configuration"),
  owner: Flag.String("owner"),
  terminate: Flag.Boolean("terminate").pipe(Flag.withDefault(false)),
  stallNextConnect: Flag.Int("stall-next-connect").pipe(Flag.optional),
  releaseStalls: Flag.Boolean("release-stalls").pipe(Flag.withDefault(false)),
  holdLock: Flag.Int("hold-lock").pipe(Flag.optional),
  stallTokenUpdateAfter: Flag.Int("stall-token-update-after").pipe(Flag.optional),
  largeAppRow: Flag.String("large-app-row").pipe(Flag.optional),
  holdLargeAppRows: Flag.Int("hold-large-app-rows").pipe(Flag.optional),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
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
        const holder = `e2e lock ${args.owner}`.slice(0, 63);
        if (Option.isSome(args.holdLock)) {
          const holding = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Pool({
                  connectionString: Redacted.value(database),
                  max: 1,
                  application_name: holder,
                }),
            ),
            (pool) => Effect.promise(() => pool.end()),
          );
          const client = yield* Effect.acquireRelease(
            Effect.promise(() => holding.connect()),
            (client) => Effect.sync(() => client.release()),
          );
          yield* Effect.promise(() =>
            client.query("SELECT pg_advisory_lock(hashtext($1))", [name]),
          );
          yield* Console.log(JSON.stringify({ locked: true }));
          yield* Effect.sleep(`${args.holdLock.value} seconds`);
          yield* Effect.promise(() =>
            client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]),
          );
          return;
        }
        const largeAppRow = args.largeAppRow;
        if (Option.isSome(largeAppRow)) {
          yield* Effect.promise(() =>
            pool.query(
              `UPDATE executor_apps SET copied_from = json_build_object(
                 'reference', (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 2000)),
                 'name', 'Large row', 'commit', NULL)
               WHERE id = $1`,
              [largeAppRow.value],
            ),
          );
        }
        if (Option.isSome(args.holdLargeAppRows)) {
          const holding = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Pool({
                  connectionString: Redacted.value(database),
                  max: 1,
                  application_name: holder,
                }),
            ),
            (pool) => Effect.promise(() => pool.end()),
          );
          const client = yield* Effect.acquireRelease(
            Effect.promise(() => holding.connect()),
            (client) =>
              Effect.promise(() => client.query("ROLLBACK")).pipe(
                Effect.ignore,
                Effect.andThen(Effect.sync(() => client.release())),
              ),
          );
          const index = yield* Effect.promise(() =>
            client.query(
              `SELECT i.indexrelid::regclass::text AS name FROM pg_class c
                 JOIN pg_index i ON i.indrelid = c.reltoastrelid
               WHERE c.oid = 'executor_apps'::regclass`,
            ),
          );
          const [toastIndex] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ name: Schema.String })]),
          )(index.rows);
          yield* Effect.promise(() => client.query("BEGIN"));
          yield* Effect.promise(() => client.query(`REINDEX INDEX ${toastIndex.name}`));
          yield* Console.log(JSON.stringify({ locked: true }));
          yield* Effect.sleep(`${args.holdLargeAppRows.value} seconds`);
          yield* Effect.promise(() => client.query("COMMIT"));
          return;
        }
        const statementStall = args.stallTokenUpdateAfter;
        if (Option.isSome(statementStall)) {
          const counter = `e2e_statement_stall.counter_${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
          yield* Effect.promise(() => pool.query(installStatementStall));
          yield* Effect.promise(() => pool.query(`DROP SEQUENCE IF EXISTS ${counter}`));
          yield* Effect.promise(() => pool.query(`CREATE SEQUENCE ${counter}`));
          yield* Effect.promise(() =>
            pool.query(
              `INSERT INTO e2e_statement_stall.armed VALUES ($1, $2, $3)
               ON CONFLICT (application_name) DO UPDATE
               SET counter = excluded.counter, stall_at = excluded.stall_at`,
              [name, counter, statementStall.value + 1],
            ),
          );
        }
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
              ? `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS connections,
                   0 AS waiting, 0 AS holding
                 FROM pg_stat_activity WHERE application_name = $1`
              : `SELECT count(*)::int AS connections,
                   count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting,
                   (SELECT count(*) FROM pg_locks l JOIN pg_stat_activity h ON h.pid = l.pid
                     WHERE h.application_name = $2 AND l.granted
                       AND (l.locktype = 'advisory' OR l.mode = 'AccessExclusiveLock'))::int
                     AS holding
                 FROM pg_stat_activity WHERE application_name = $1`,
            args.terminate ? [name] : [name, holder],
          ),
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              connections: Schema.Number,
              waiting: Schema.Number,
              holding: Schema.Number,
            }),
          ]),
        )(result.rows);
        yield* Console.log(JSON.stringify(rows[0]));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
