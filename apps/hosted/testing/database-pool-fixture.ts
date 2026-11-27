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
  Deferred,
  Duration,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
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
  "connect-abandoned",
  "commit-unanswered",
  "commit-rollback",
] as const;

const cancelRequestCode = 80877102;

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

const commitHoldingProxy = (target: URL, holdMillis: number) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: Net.Server; readonly behindCommit: { count: number } }>(
      (resume) => {
        const behindCommit = { count: 0 };
        const sockets = new Set<Net.Socket>();
        const server = Net.createServer((client) => {
          sockets.add(client);
          const upstream = Net.connect(Number(target.port || 5432), target.hostname);
          sockets.add(upstream);
          let holding = false;
          let held: Array<Buffer> = [];
          let rest = Buffer.alloc(0);
          upstream.on("data", (chunk: Buffer) => {
            rest = Buffer.concat([rest, chunk]);
            while (rest.length >= 5) {
              const length = rest.readInt32BE(1) + 1;
              if (rest.length < length) break;
              const message = rest.subarray(0, length);
              rest = rest.subarray(length);
              const tag =
                message[0] === 0x43 ? message.subarray(5, length - 1).toString("latin1") : "";
              const commit = tag === "COMMIT" || tag === "ROLLBACK";
              if (commit && !holding) {
                holding = true;
                setTimeout(() => {
                  holding = false;
                  const out = Buffer.concat(held);
                  held = [];
                  if (!client.destroyed) client.write(out);
                }, holdMillis);
              }
              if (holding) held.push(Buffer.from(message));
              else client.write(message);
            }
          });
          client.on("data", (chunk) => {
            if (holding) behindCommit.count++;
            upstream.write(chunk);
          });
          upstream.once("close", () => {
            sockets.delete(upstream);
            client.destroy();
          });
          client.once("close", () => {
            sockets.delete(client);
            upstream.destroy();
          });
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
        });
        server.on("close", () => {
          for (const socket of sockets) socket.destroy();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, behindCommit })));
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
        const run = randomBytes(6).toString("hex");
        const applicationName = `e2e pool ${run}`;
        const table = `e2e_pool_${run}`;
        const lockKey = Number.parseInt(run.slice(0, 7), 16);
        const gateKey = lockKey + 2 ** 28;

        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: target.toString(), max: 3 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const adminQuery = (text: string, values: ReadonlyArray<unknown> = []) =>
          Effect.promise(() => admin.query(text, [...values]));

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

        const holdLock = (key: number) =>
          Effect.acquireRelease(
            Effect.promise(async () => {
              const client = await admin.connect();
              await client.query("SELECT pg_advisory_lock($1)", [key]);
              return client;
            }),
            (client) =>
              Effect.promise(async () => {
                await client.query("SELECT pg_advisory_unlock($1)", [key]);
                client.release();
              }),
          );
        const lockWait = (pool: PgPool.PgPool, millis: number) =>
          pool
            .use((connection) =>
              connection.query("SELECT pg_advisory_xact_lock($1)", [lockKey], false),
            )
            .pipe(Effect.timeoutOption(`${millis} millis`), Effect.exit);
        const waitingOnLock = adminQuery(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'",
          [applicationName],
        ).pipe(
          Effect.filterOrFail(
            (result) => result.rows[0].waiting > 0,
            () => new Error("No statement of the run waits on a lock"),
          ),
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1_000 }),
          Effect.orDie,
        );

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
              yield* holdLock(lockKey);
              const { pool: shared } = yield* pool({ maxConnections: 4, cancels: "dropped" });
              const inserted = yield* Deferred.make<void>();
              const gaveUp = yield* Deferred.make<void>();
              const [twoStatements, sibling] = yield* PgPool.grouped(
                Effect.all(
                  [
                    shared
                      .use((connection) =>
                        connection
                          .query(`INSERT INTO ${table} DEFAULT VALUES`, [], false)
                          .pipe(
                            Effect.ensuring(Deferred.succeed(inserted, undefined)),
                            Effect.andThen(Deferred.await(gaveUp)),
                            Effect.andThen(connection.query("SELECT 1", [], false)),
                          ),
                      )
                      .pipe(Effect.exit),
                    Deferred.await(inserted).pipe(
                      Effect.andThen(lockWait(shared, 40)),
                      Effect.tap(() => Deferred.succeed(gaveUp, undefined)),
                    ),
                  ],
                  { concurrency: "unbounded" },
                ),
              );
              const leased = yield* Deferred.make<void>();
              const otherGaveUp = yield* Deferred.make<void>();
              const [firstRead, otherSibling] = yield* PgPool.grouped(
                Effect.all(
                  [
                    shared
                      .use((connection) =>
                        Deferred.succeed(leased, undefined).pipe(
                          Effect.andThen(Deferred.await(otherGaveUp)),
                          Effect.andThen(
                            connection.query("SELECT pg_backend_pid() AS pid", [], false),
                          ),
                        ),
                      )
                      .pipe(Effect.exit),
                    Deferred.await(leased).pipe(
                      Effect.andThen(lockWait(shared, 40)),
                      Effect.tap(() => Deferred.succeed(otherGaveUp, undefined)),
                    ),
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
              const { pool: single } = yield* pool({ maxConnections: 1 });
              const before = yield* pid(single);
              const start = Date.now();
              const sleeper = yield* PgPool.held(
                single.use((connection) =>
                  connection.query("SELECT pg_backend_pid() AS pid, pg_sleep(6)", [], false).pipe(
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
                    yield* holdLock(lockKey);
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
            case "connect-abandoned": {
              const silent = yield* Effect.acquireRelease(
                Effect.callback<{
                  readonly server: Net.Server;
                  readonly sockets: { accepted: number; open: number };
                  readonly held: Set<Net.Socket>;
                }>((resume) => {
                  const sockets = { accepted: 0, open: 0 };
                  const held = new Set<Net.Socket>();
                  const server = Net.createServer((socket) => {
                    sockets.accepted++;
                    sockets.open++;
                    held.add(socket);
                    socket.on("close", () => {
                      sockets.open--;
                      held.delete(socket);
                    });
                    socket.on("error", () => undefined);
                    socket.resume();
                  });
                  server.listen(0, "127.0.0.1", () =>
                    resume(Effect.succeed({ server, sockets, held })),
                  );
                }),
                ({ server, held }) =>
                  Effect.callback<void>((resume) => {
                    for (const socket of held) socket.destroy();
                    server.close(() => resume(Effect.void));
                  }),
              );
              const address = silent.server.address();
              if (address === null || typeof address === "string")
                return yield* Effect.die("The silent server has no port");
              const url = new URL(target.toString());
              url.hostname = "127.0.0.1";
              url.port = String(address.port);
              const leftOpen = Effect.sleep("500 millis").pipe(
                Effect.map(() => silent.sockets.open),
              );
              const timedOut = yield* Effect.exit(
                Effect.scoped(
                  PgConnection.make({
                    url: Redacted.make(url.toString()),
                    connectTimeout: Duration.millis(300),
                    connectRetries: 1,
                  }),
                ),
              );
              const afterTimeout = { attempts: silent.sockets.accepted, open: yield* leftOpen };
              const interrupted = yield* Effect.exit(
                Effect.scoped(
                  PgConnection.make({
                    url: Redacted.make(url.toString()),
                    connectTimeout: Duration.seconds(10),
                  }),
                ).pipe(Effect.timeout(Duration.millis(200))),
              );
              return {
                timedOut:
                  Exit.isFailure(timedOut) &&
                  String(timedOut.cause).includes("Connection timed out")
                    ? "timed out"
                    : outcome(timedOut),
                afterTimeout,
                interrupted: outcome(interrupted),
                afterInterrupt: {
                  attempts: silent.sockets.accepted - afterTimeout.attempts,
                  open: yield* leftOpen,
                },
              };
            }
            case "commit-unanswered":
            case "commit-rollback": {
              const holding = yield* commitHoldingProxy(target, 300);
              const address = holding.server.address();
              if (address === null || typeof address === "string")
                return yield* Effect.die("The proxy has no port");
              const url = new URL(target.toString());
              url.hostname = "127.0.0.1";
              url.port = String(address.port);
              const client = yield* Layer.build(
                PgClient.layer({
                  url: Redacted.make(url.toString()),
                  applicationName,
                  maxConnections: 2,
                  multiplex: true,
                  multiplexConcurrency: 1,
                  prepare: false,
                }),
              ).pipe(Effect.orDie);
              const sql = Context.get(client, SqlClient.SqlClient);
              let later = "not read";
              const recheck = Effect.gen(function* () {
                yield* sql`SELECT 1 AS first`;
                const rows = yield* sql<{ readonly later: number }>`SELECT 2 AS later`;
                later = rows[0]?.later === 2 ? "answered" : "wrong rows";
              });
              const inside = args.case === "commit-rollback" ? sql`SELECT 1 / 0` : sql`SELECT 3`;
              const exits = yield* PgPool.held(
                PgConnection.pipelined([recheck, inside, sql`SELECT 4`], {
                  outside: 1,
                  begin: "ISOLATION LEVEL REPEATABLE READ READ ONLY",
                }),
              ).pipe(Effect.timeoutOption("10 seconds"));
              return {
                leaves: Option.match(exits, {
                  onNone: () => "timed out",
                  onSome: (exits) => exits.map((exit) => (Exit.isSuccess(exit) ? "ok" : "failed")),
                }),
                behindCommit: holding.behindCommit.count,
                later,
              };
            }
            case "batch": {
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
              const outside = yield* Effect.exit(batch);
              const refused =
                Exit.isFailure(outside) &&
                Cause.hasDies(outside.cause) &&
                String(Cause.squash(outside.cause)).includes("must run inside PgPool.held");
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
              yield* holdLock(lockKey);
              const { pool: shared } = yield* pool({ maxConnections: 4, cancels: "dropped" });
              return yield* PgPool.grouped(
                Effect.gen(function* () {
                  const { awaited, abandoned } = yield* Effect.scoped(
                    Effect.gen(function* () {
                      yield* holdLock(gateKey);
                      const awaited = yield* shared
                        .use((connection) =>
                          connection.query("SELECT pg_advisory_xact_lock($1)", [gateKey], false),
                        )
                        .pipe(Effect.exit, Effect.forkChild);
                      yield* waitingOnLock;
                      return { awaited, abandoned: yield* lockWait(shared, 50) };
                    }),
                  );
                  const opened = Date.now();
                  const exit = yield* Fiber.join(awaited);
                  return {
                    awaited: outcome(exit),
                    awaitedReturned: since(opened),
                    gaveUp: Exit.isSuccess(abandoned) && abandoned.value._tag === "None",
                  };
                }),
              );
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
