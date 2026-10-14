/**
 * Local-only probe of the patched `@effect/sql-pg` pool that Cloud's session objects use
 * (`multiplex` with `multiplexConcurrency` 1, statement groups, `PgPool.held`). Each case opens its
 * own pools against the local database, under its own application name, and prints what it saw as
 * JSON for `cloud-database-placement.spec.ts` to judge. Cases that need a cancel that never lands
 * connect through a proxy here that drops every `CancelRequest`. Never installed in the HTTP server.
 *
 * - `use-once`: a `PgPool.use` callback that already sent a statement is not run again when a
 *   later statement of it is refused; one that sent nothing is.
 * - `held-nested`: a hold inside a hold uses the outer hold's connection.
 * - `held-shared`: `PgPool.isHeld` is true only on a pool that leases connections exclusively.
 * - `held-unawaited`: a hold that wrote a statement nobody awaits keeps the connection until that
 *   statement finishes, longer than the cancellation bound (but within the 30 s bound below), and
 *   does not break it.
 * - `held-hung`: a statement nobody awaits that is still running 30 s after its hold returned is
 *   cancelled and its connection closed as broken; the pool opens another.
 * - `drain`: an abandoned statement whose cancel never lands breaks its connection after the 5 s
 *   cancellation bound, and the pool replaces it; with the cancel delivered, the connection is kept.
 * - `sibling`: a statement of a group that finishes while another statement of the group drains
 *   returns at once.
 * - `batch`: a `PgConnection.pipelined` batch with `BEGIN` runs on one held connection in one
 *   snapshot inside `PgPool.held`, and refuses to write `BEGIN` outside a hold. A batch whose
 *   pool cannot connect (both attempts closed at once, as by a restarting pooler) returns each
 *   leaf's failure rather than failing itself.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient } from "@effect/sql-pg";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import * as PgPool from "@effect/sql-pg/PgPool";
import { randomBytes } from "node:crypto";
import * as Net from "node:net";
import { Pool } from "pg";
import {
  Config,
  Console,
  Effect,
  Cause,
  Context,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const cases = [
  "use-once",
  "held-nested",
  "held-shared",
  "held-unawaited",
  "held-hung",
  "drain",
  "sibling",
  "batch",
] as const;

/** The protocol code of a `CancelRequest`, the first message on its own connection. */
const cancelRequestCode = 80877102;

/**
 * A TCP proxy to the database that counts `CancelRequest`s and, with `dropCancels`, closes their
 * connections without passing them on, as a cancel lost on the way does.
 */
const proxy = (target: URL, dropCancels: boolean) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: Net.Server; readonly cancels: { count: number } }>(
      (resume) => {
        const cancels = { count: 0 };
        const sockets = new Set<Net.Socket>();
        const server = Net.createServer((client) => {
          sockets.add(client);
          client.once("close", () => sockets.delete(client));
          client.once("data", (first) => {
            if (
              typeof first !== "string" &&
              first.length >= 8 &&
              first.readInt32BE(4) === cancelRequestCode
            ) {
              cancels.count++;
              if (dropCancels) return client.destroy();
            }
            const upstream = Net.connect(Number(target.port || 5432), target.hostname);
            sockets.add(upstream);
            upstream.once("close", () => {
              sockets.delete(upstream);
              client.destroy();
            });
            client.once("close", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
            client.on("error", () => upstream.destroy());
            upstream.write(first);
            client.pipe(upstream).pipe(client);
          });
        });
        server.on("close", () => {
          for (const socket of sockets) socket.destroy();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, cancels })));
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.emit("close");
      }),
  );

const command = Command.make("database-pool-fixture", {
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
        // This run's own name, table and lock, so parallel scenarios on the shared database are
        // untouched.
        const run = randomBytes(6).toString("hex");
        const applicationName = `e2e pool ${run}`;
        const table = `e2e_pool_${run}`;
        const lockKey = Number.parseInt(run.slice(0, 7), 16);

        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: target.toString(), max: 2 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const adminQuery = (text: string, values: ReadonlyArray<unknown> = []) =>
          Effect.promise(() => admin.query(text, [...values]));

        /** A pool of the given shape, through a proxy when `cancels` is set. */
        const pool = (options: {
          readonly multiplexConcurrency?: number;
          readonly multiplex?: boolean;
          readonly maxConnections: number;
          readonly cancels?: "dropped" | "delivered";
        }): Effect.Effect<
          { readonly pool: PgPool.PgPool; readonly cancels: { count: number } },
          never,
          Scope.Scope
        > =>
          Effect.gen(function* () {
            let url = target;
            let cancels = { count: 0 };
            if (options.cancels !== undefined) {
              const proxied = yield* proxy(target, options.cancels === "dropped");
              const address = proxied.server.address();
              if (address === null || typeof address === "string")
                return yield* Effect.die("The proxy has no port");
              url = new URL(target.toString());
              url.hostname = "127.0.0.1";
              url.port = String(address.port);
              cancels = proxied.cancels;
            }
            const made = yield* PgPool.make({
              url: Redacted.make(url.toString()),
              applicationName,
              maxConnections: options.maxConnections,
              multiplex: options.multiplex ?? true,
              multiplexConcurrency: options.multiplexConcurrency ?? 1,
              prepare: false,
            }).pipe(Effect.orDie);
            return { pool: made, cancels };
          });

        const pid = (pool: PgPool.PgPool) =>
          pool
            .use((connection) => connection.query("SELECT pg_backend_pid() AS pid", [], false))
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ pid: Schema.Number })]))(
                  result.rows,
                ),
              ),
              Effect.map(([row]) => row.pid),
              Effect.orDie,
            );

        /** Holds the run's advisory lock on its own connection until the scope closes. */
        const holdLock = Effect.acquireRelease(
          Effect.promise(async () => {
            const client = await admin.connect();
            await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
            return client;
          }),
          (client) =>
            Effect.promise(async () => {
              await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
              client.release();
            }),
        );
        /** A statement that waits on the run's lock, given up on after `millis`. */
        const lockWait = (pool: PgPool.PgPool, millis: number) =>
          pool
            .use((connection) =>
              connection.query("SELECT pg_advisory_xact_lock($1)", [lockKey], false),
            )
            .pipe(Effect.timeoutOption(`${millis} millis`), Effect.exit);

        const since = (start: number) => Date.now() - start;
        const outcome = <A, E>(exit: Exit.Exit<A, E>) =>
          Exit.isSuccess(exit)
            ? "ok"
            : String(exit.cause).includes("The connection takes no new statements")
              ? "refused"
              : "failed";

        const result: Record<string, unknown> = yield* Effect.gen(function* () {
          switch (args.case) {
            case "use-once": {
              yield* adminQuery(`CREATE TABLE ${table} (id serial PRIMARY KEY)`);
              yield* Effect.addFinalizer(() => adminQuery(`DROP TABLE IF EXISTS ${table}`));
              yield* holdLock;
              // Cancels never land, so the abandoned lock wait keeps its connection refusing.
              const { pool: shared } = yield* pool({ maxConnections: 4, cancels: "dropped" });
              // One group: a callback inserts, then reads after its sibling on the same connection
              // has given up on a lock wait. The read is refused unsent; the insert was sent.
              const [twoStatements, sibling] = yield* PgPool.grouped(
                Effect.all(
                  [
                    shared
                      .use((connection) =>
                        connection
                          .query(`INSERT INTO ${table} DEFAULT VALUES`, [], false)
                          .pipe(
                            Effect.andThen(Effect.sleep("150 millis")),
                            Effect.andThen(connection.query("SELECT 1", [], false)),
                          ),
                      )
                      .pipe(Effect.exit),
                    Effect.sleep("20 millis").pipe(Effect.andThen(lockWait(shared, 40))),
                  ],
                  { concurrency: "unbounded" },
                ),
              );
              // Another group: the same, but the callback sends nothing before its read is refused.
              const [firstRead, otherSibling] = yield* PgPool.grouped(
                Effect.all(
                  [
                    shared
                      .use((connection) =>
                        Effect.sleep("150 millis").pipe(
                          Effect.andThen(
                            connection.query("SELECT pg_backend_pid() AS pid", [], false),
                          ),
                        ),
                      )
                      .pipe(Effect.exit),
                    Effect.sleep("20 millis").pipe(Effect.andThen(lockWait(shared, 40))),
                  ],
                  { concurrency: "unbounded" },
                ),
              );
              const rows = yield* adminQuery(`SELECT count(*)::int AS rows FROM ${table}`);
              return {
                rows: rows.rows[0].rows,
                twoStatements: outcome(twoStatements),
                siblingGaveUp: Exit.isSuccess(sibling) && sibling.value._tag === "None",
                firstRead: outcome(firstRead),
                otherSiblingGaveUp:
                  Exit.isSuccess(otherSibling) && otherSibling.value._tag === "None",
              };
            }
            case "held-nested": {
              const { pool: shared } = yield* pool({ maxConnections: 4 });
              let split = 0;
              for (let round = 0; round < 20; round++) {
                const [outer, inner] = yield* PgPool.held(
                  Effect.all([pid(shared), PgPool.held(pid(shared))], {
                    concurrency: "unbounded",
                  }),
                );
                if (outer !== inner) split++;
              }
              return { rounds: 20, split };
            }
            case "held-shared": {
              const heldThere = (shape: Parameters<typeof pool>[0]) =>
                Effect.flatMap(pool(shape), ({ pool: made }) =>
                  PgPool.held(made.use((connection) => Effect.succeed(PgPool.isHeld(connection)))),
                ).pipe(Effect.orDie);
              return {
                exclusive: yield* heldThere({ maxConnections: 1 }),
                shared: yield* heldThere({ maxConnections: 1, multiplexConcurrency: 4 }),
                plain: yield* heldThere({ maxConnections: 1, multiplex: false }),
              };
            }
            case "held-unawaited": {
              // One connection, so the next statement can only run once the hold gave it back.
              const { pool: single } = yield* pool({ maxConnections: 1 });
              const before = yield* pid(single);
              const start = Date.now();
              // The hold writes a 6 s statement (longer than the 5 s cancellation bound) that a
              // detached fiber, not the hold, awaits, as a batch's `COMMIT` nobody awaits.
              const sleeper = yield* PgPool.held(
                single.use((connection) =>
                  connection.query("SELECT pg_backend_pid() AS pid, pg_sleep(6)", [], false).pipe(
                    Effect.map(() => since(start)),
                    Effect.exit,
                    Effect.forkDetach,
                    // The detached fiber writes the statement asynchronously: let it reach the wire
                    // while the hold still has the connection.
                    Effect.tap(() => Effect.sleep("50 millis")),
                  ),
                ),
              );
              const heldReturned = since(start);
              const after = yield* pid(single);
              const next = since(start);
              const slept = yield* Fiber.join(sleeper);
              return {
                heldReturned,
                sleeper: outcome(slept),
                sleeperFinished: Exit.isSuccess(slept) ? slept.value : null,
                next,
                sameConnection: before === after,
              };
            }
            case "held-hung": {
              const { pool: single } = yield* pool({ maxConnections: 1 });
              const before = yield* pid(single);
              const start = Date.now();
              // As `held-unawaited`, but the statement outlives the 30 s bound on what nobody awaits.
              const sleeper = yield* PgPool.held(
                single.use((connection) =>
                  connection.query("SELECT pg_sleep(45)", [], false).pipe(
                    Effect.map(() => since(start)),
                    Effect.exit,
                    Effect.forkDetach,
                    Effect.tap(() => Effect.sleep("50 millis")),
                  ),
                ),
              );
              const heldReturned = since(start);
              const after = yield* pid(single);
              const next = since(start);
              const slept = yield* Fiber.join(sleeper);
              const sleeperEnded = since(start);
              // The cancel sent before the close stops the old backend's statement.
              yield* Effect.sleep("500 millis");
              const stillRunning = yield* adminQuery(
                "SELECT count(*)::int AS running FROM pg_stat_activity WHERE pid = $1 AND state = 'active'",
                [before],
              );
              return {
                heldReturned,
                sleeper: outcome(slept),
                sleeperError: Exit.isFailure(slept) ? String(slept.cause) : null,
                sleeperEnded,
                next,
                sameConnection: before === after,
                oldBackendRunning: stillRunning.rows[0].running,
              };
            }
            case "drain": {
              const arm = (cancels: "dropped" | "delivered") =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* holdLock;
                    const { pool: single, cancels: seen } = yield* pool({
                      maxConnections: 1,
                      cancels,
                    });
                    const before = yield* pid(single);
                    const start = Date.now();
                    const abandoned = yield* PgPool.grouped(lockWait(single, 50));
                    const callerReturned = since(start);
                    const after = yield* pid(single);
                    return {
                      gaveUp: Exit.isSuccess(abandoned) && abandoned.value._tag === "None",
                      callerReturned,
                      next: since(start),
                      sameConnection: before === after,
                      cancelRequests: seen.count,
                    };
                  }),
                );
              return { dropped: yield* arm("dropped"), delivered: yield* arm("delivered") };
            }
            case "batch": {
              // A client of the session objects' shape: its statements go through the borrower
              // that `pipelined` claims them from.
              const client = yield* Layer.build(
                PgClient.layer({
                  url: Redacted.make(target.toString()),
                  applicationName,
                  maxConnections: 2,
                  multiplex: true,
                  multiplexConcurrency: 1,
                  prepare: false,
                }),
              ).pipe(Effect.orDie);
              const sql = Context.get(client, SqlClient.SqlClient);
              const Row = Schema.Tuple([
                Schema.Struct({ pid: Schema.Number, snapshot: Schema.String }),
              ]);
              const leaf =
                sql`SELECT pg_backend_pid() AS pid, pg_current_snapshot()::text AS snapshot`.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Row)),
                  Effect.map(([row]) => row),
                );
              const batch = PgConnection.pipelined([leaf, leaf, leaf, leaf], {
                begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY",
              });
              const rows = (exits: ReadonlyArray<Exit.Exit<unknown, unknown>>) =>
                exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));
              const held = yield* PgPool.held(batch);
              const heldRows = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ pid: Schema.Number, snapshot: Schema.String })),
              )(rows(held));
              // Outside a hold the batch writes nothing and dies.
              const outside = yield* Effect.exit(batch);
              const refused =
                Exit.isFailure(outside) &&
                Cause.hasDies(outside.cause) &&
                String(Cause.squash(outside.cause)).includes("must run inside PgPool.held");
              // A server that closes every connection at once: each connect attempt, the first and
              // its retry, fails before the batch has a connection.
              const closing = yield* Effect.acquireRelease(
                Effect.callback<{
                  readonly server: Net.Server;
                  readonly attempts: { count: number };
                }>((resume) => {
                  const attempts = { count: 0 };
                  const server = Net.createServer((socket) => {
                    attempts.count++;
                    socket.destroy();
                  });
                  server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, attempts })));
                }),
                ({ server }) =>
                  Effect.callback<void>((resume) => {
                    server.close(() => resume(Effect.void));
                  }),
              );
              const address = closing.server.address();
              if (address === null || typeof address === "string")
                return yield* Effect.die("The closing server has no port");
              const unreachable = new URL(target.toString());
              unreachable.hostname = "127.0.0.1";
              unreachable.port = String(address.port);
              const down = yield* Layer.build(
                PgClient.layer({
                  url: Redacted.make(unreachable.toString()),
                  applicationName,
                  maxConnections: 2,
                  multiplex: true,
                  multiplexConcurrency: 1,
                  prepare: false,
                  connectRetries: 1,
                }),
              ).pipe(Effect.orDie);
              const downSql = Context.get(down, SqlClient.SqlClient);
              const lost = yield* Effect.exit(
                PgPool.held(
                  PgConnection.pipelined(
                    [downSql`SELECT 1`, downSql`SELECT 2`, downSql`SELECT 3`],
                    {
                      outside: 1,
                      begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY",
                    },
                  ),
                ),
              );
              return {
                held: {
                  ok: heldRows.length,
                  backends: new Set(heldRows.map((row) => row.pid)).size,
                  snapshots: new Set(heldRows.map((row) => row.snapshot)).size,
                },
                outside: { refused },
                unreachable: {
                  attempts: closing.attempts.count,
                  batch: Exit.isSuccess(lost) ? "returned" : String(lost.cause),
                  leaves: Exit.isSuccess(lost)
                    ? lost.value.map((exit) =>
                        Exit.isSuccess(exit)
                          ? "ok"
                          : String(exit.cause).includes(
                                "PgConnection: Connection closed during startup",
                              )
                            ? "could not connect"
                            : String(exit.cause),
                      )
                    : [],
                },
              };
            }
            case "sibling": {
              yield* holdLock;
              const { pool: shared } = yield* pool({ maxConnections: 4, cancels: "dropped" });
              const start = Date.now();
              // A sibling queued behind the awaited statement gives up on its lock wait; its
              // cancel never lands, so draining it takes the 5 s bound.
              const [awaited, abandoned] = yield* PgPool.grouped(
                Effect.all(
                  [
                    shared
                      .use((connection) => connection.query("SELECT pg_sleep(0.2)", [], false))
                      .pipe(
                        Effect.exit,
                        Effect.map((exit) => ({ exit, at: since(start) })),
                      ),
                    Effect.sleep("10 millis").pipe(
                      Effect.andThen(lockWait(shared, 50)),
                      Effect.map((exit) => ({ exit, at: since(start) })),
                    ),
                  ],
                  { concurrency: "unbounded" },
                ),
              );
              return {
                awaited: outcome(awaited.exit),
                awaitedReturned: awaited.at,
                gaveUp: Exit.isSuccess(abandoned.exit) && abandoned.exit.value._tag === "None",
                abandonedReturned: abandoned.at,
              };
            }
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
