import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient } from "@effect/sql-pg";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import * as PgPool from "@effect/sql-pg/PgPool";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  Cause,
  Config,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Redacted,
  Schema,
  Tracer,
} from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";
import { halfOpenProxy } from "./half-open-proxy.ts";

const cases = [
  "read",
  "write",
  "transaction",
  "down",
  "cap",
  "burst",
  "drop-one",
  "held",
  "classify",
] as const;

const classified: ReadonlyArray<readonly [string, "read" | "write"]> = [
  ["SELECT 1", "read"],
  ["select updated_at, deleted_at, lock_id from t where id = $1", "read"],
  ["WITH a AS (SELECT 1) SELECT * FROM a", "read"],
  ["SELECT count(*)::int FROM t", "read"],
  ["SELECT my_function($1)", "read"],
  ["INSERT INTO t (id) VALUES (1)", "write"],
  ["UPDATE t SET a = 1", "write"],
  ["DELETE FROM t", "write"],
  ["WITH k AS (SELECT id FROM t) UPDATE t SET used = true FROM k WHERE t.id = k.id", "write"],
  ["WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", "write"],
  ["SELECT * FROM t FOR UPDATE", "write"],
  ["SELECT * FROM t\nFOR\n  NO KEY UPDATE", "write"],
  ["SELECT * FROM t FOR SHARE", "write"],
  ["SELECT * FROM t FOR KEY SHARE", "write"],
  ["SELECT * INTO u FROM t", "write"],
  ["SELECT nextval('s')", "write"],
  ["SELECT setval('s', 1)", "write"],
  ["SELECT pg_advisory_lock(1)", "write"],
  ["SELECT pg_advisory_xact_lock(1)", "write"],
  ["SELECT pg_try_advisory_lock(1)", "write"],
  ["SELECT pg_try_advisory_xact_lock(1)", "write"],
  ["SELECT pg_advisory_unlock_all()", "write"],
  ["SELECT set_config('a.b', 'c', false)", "write"],
  ["SELECT pg_notify('c', 'p')", "write"],
  ["SELECT pg_terminate_backend(1)", "write"],
  ["SELECT pg_cancel_backend(1)", "write"],
  ["SELECT lo_unlink(1)", "write"],
  ["SELECT lo_import('/f')", "write"],
  ["SELECT 1; DELETE FROM t", "write"],
  ["/* note */ SELECT 1", "write"],
  ["(SELECT 1)", "write"],
  ["VALUES (1)", "write"],
  ["TABLE t", "write"],
  ["EXPLAIN ANALYZE SELECT 1", "write"],
  ["SHOW search_path", "write"],
  ["BEGIN", "write"],
  ["LOCK TABLE t", "write"],
  ["TRUNCATE t", "write"],
  ["CALL p()", "write"],
  ["DO $$ BEGIN END $$", "write"],
];

const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const repeats = () =>
    spans
      .filter((span) => span.name === "sql.connection.repeat")
      .map((span) => Object.fromEntries(span.attributes));
  return { tracer, repeats };
};

const outcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? "ok" : Cause.pretty(exit.cause).split("\n")[0];

const command = Command.make("connection-repeat-fixture", {
  configuration: Flag.String("configuration"),
  case: Flag.Literals("case", cases),
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
        const target = new URL(Redacted.value(database));
        const run = randomBytes(6).toString("hex");
        const table = `e2e_repeat_${run}`;
        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: target.toString(), max: 1 })),
          (pool) =>
            Effect.promise(() =>
              pool.query(`DROP TABLE IF EXISTS ${table}`).then(() => pool.end()),
            ),
        );
        yield* Effect.promise(() => admin.query(`CREATE TABLE ${table} (id int PRIMARY KEY)`));
        const rows = Effect.promise(() =>
          admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`),
        ).pipe(Effect.map((result) => result.rows[0]?.count ?? -1));

        const proxy = yield* halfOpenProxy({
          host: target.hostname,
          port: Number(target.port || 5432),
        });
        const proxied = new URL(target.toString());
        proxied.hostname = "127.0.0.1";
        proxied.port = String(proxy.port);
        const client = (shape: "event" | "object") =>
          PgClient.layer({
            url: Redacted.make(proxied.toString()),
            maxConnections: shape === "event" ? 2 : 4,
            applicationName: `e2e repeat ${run} ${shape}`,
            ...(shape === "object" ? { multiplex: true, multiplexConcurrency: 1 } : {}),
            prepare: false,
            connectTimeout: Duration.millis(2500),
            connectRetries: 1,
          });
        const afterDrop = <A, E>(
          shape: "event" | "object",
          program: (sql: SqlClient.SqlClient, drop: Effect.Effect<void>) => Effect.Effect<A, E>,
          options: {
            readonly refuse?: boolean;
            readonly warm?: number;
            readonly drop?: "all" | "one";
          } = {},
        ) => {
          const { tracer, repeats } = recording();
          return Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* Effect.all(
              Array.from({ length: options.warm ?? 1 }, () => sql`SELECT pg_sleep(0.05)`),
              { concurrency: "unbounded", discard: true },
            );
            let dropped = 0;
            let started = 0;
            let openedBefore = 0;
            const drop = Effect.sync(() => {
              openedBefore = proxy.opened();
              dropped = options.drop === "one" ? proxy.dropOne() : proxy.dropAll();
              if (options.refuse === true) proxy.refuse(true);
              proxy.resetPeak();
              started = Date.now();
            });
            const exit = yield* Effect.exit(program(sql, drop));
            const millis = Date.now() - started;
            yield* Effect.sleep("200 millis");
            return {
              dropped,
              outcome: outcome(exit),
              millis,
              connects: proxy.opened() - openedBefore,
              peak: proxy.peak(),
              healthyClosed: proxy.healthyClosed(),
              repeats: repeats(),
            };
          }).pipe(Effect.withTracer(tracer), Effect.provide(client(shape)), Effect.scoped);
        };
        const then =
          <A, E>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
          (sql: SqlClient.SqlClient, drop: Effect.Effect<void>) =>
            Effect.andThen(drop, statement(sql));
        const many = (reads: number) => (sql: SqlClient.SqlClient, drop: Effect.Effect<void>) =>
          Effect.andThen(
            drop,
            Effect.all(
              Array.from({ length: reads }, () => Effect.exit(sql`SELECT 2::int AS n`)),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.flatMap((exits) => {
                const failed = exits.filter(Exit.isFailure).length;
                return failed === 0
                  ? Effect.succeed(exits.length)
                  : Effect.fail(`${failed} of ${exits.length} reads failed`);
              }),
            ),
          );

        const result = yield* Effect.gen(function* () {
          switch (args.case) {
            case "read":
              return {
                event: yield* afterDrop(
                  "event",
                  then((sql) => sql`SELECT 2::int AS n`),
                ),
                object: yield* afterDrop(
                  "object",
                  then((sql) => sql`SELECT 2::int AS n`),
                ),
              };
            case "write": {
              const event = yield* afterDrop(
                "event",
                then((sql) => sql`INSERT INTO ${sql(table)} (id) VALUES (1)`),
              );
              const eventRows = yield* rows;
              const object = yield* afterDrop(
                "object",
                then((sql) => PgPool.grouped(sql`INSERT INTO ${sql(table)} (id) VALUES (2)`)),
              );
              return {
                event: { ...event, rows: eventRows },
                object: { ...object, rows: yield* rows },
              };
            }
            case "transaction":
              return yield* afterDrop("event", (sql, drop) =>
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`SELECT 1 AS first`;
                    yield* drop;
                    return yield* sql`SELECT 2::int AS n`;
                  }),
                ),
              );
            case "down":
              return yield* afterDrop(
                "event",
                then((sql) => sql`SELECT 2::int AS n`),
                {
                  refuse: true,
                },
              );
            case "cap":
              return {
                event: yield* afterDrop("event", many(8), { warm: 2 }),
                object: yield* afterDrop("object", many(8), { warm: 4 }),
              };
            case "burst":
              return yield* afterDrop(
                "object",
                then((sql) => sql`SELECT 2::int AS n`),
                { warm: 4 },
              );
            case "drop-one": {
              const runs = [];
              for (let index = 0; index < 8; index++)
                runs.push(
                  yield* afterDrop(
                    "object",
                    then((sql) => sql`SELECT 2::int AS n`),
                    {
                      warm: 4,
                      drop: "one",
                    },
                  ),
                );
              return { runs };
            }
            case "held":
              return yield* afterDrop("object", (sql, drop) =>
                PgPool.held(
                  PgConnection.pipelined(
                    [
                      Effect.gen(function* () {
                        yield* sql`SELECT 1 AS first`;
                        yield* drop;
                        return yield* sql`SELECT 2::int AS n`;
                      }),
                    ],
                    { outside: 0, begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY" },
                  ),
                ).pipe(
                  Effect.flatMap((exits) => {
                    const failed = exits.find(Exit.isFailure);
                    return failed === undefined ? Effect.void : Effect.failCause(failed.cause);
                  }),
                ),
              );
            case "classify":
              return {
                mismatches: classified
                  .filter(
                    ([sql, expected]) =>
                      (PgConnection.readOnlyStatement(sql) ? "read" : "write") !== expected,
                  )
                  .map(([sql, expected]) => ({ sql, expected })),
                statements: classified.length,
              };
          }
        });
        yield* Console.log(JSON.stringify(result));
      }),
    ),
  ),
);

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
