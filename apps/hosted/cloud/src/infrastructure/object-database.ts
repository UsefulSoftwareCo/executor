/**
 * Durable Objects keep their database connections across calls. A Worker event owns its own
 * connections and closes them with the event (`invocation-database.ts`); a Durable
 * Object serves many calls in one I/O context, so reconnecting in every call, or in every MCP
 * operation, only repeats the TLS login to PgBouncer.
 */
import type { PgClient } from "@effect/sql-pg";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Semaphore,
  Tracer,
} from "effect";
import type { SqlClient } from "effect/sql";
import {
  ConnectionReservations,
  type OpenedConnections,
  cloudDatabaseConnection,
  cloudDatabasePool,
} from "./database.ts";

/**
 * An object closes its connections this long after its last call ends. PgBouncer pools in
 * transaction mode, so an idle client connection holds no Postgres backend meanwhile.
 */
const idleWindow = Duration.seconds(30);

/**
 * Connections one object may hold, shared by the executor and Better Auth: enough that a
 * transaction in one MCP operation does not stall every other operation of the session. The
 * pool opens them on demand. See notes/database-pool.md for the resulting PgBouncer client total.
 */
export const objectConnectionLimit = 4;

/** A database client and what its consumers need beside it. */
export type SqlServices =
  | PgClient.PgClient
  | SqlClient.SqlClient
  | ConnectionReservations
  | OpenedConnections;

/** A call holding the object's connections: where the connections it opens are reported. */
interface Caller {
  readonly tracer: Tracer.Tracer;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

/** One activity window: the connections an object holds between idle periods. */
interface ActiveWindow {
  readonly sql: Context.Context<SqlServices>;
  readonly scope: Scope.Closeable;
  leases: number;
  idle: Fiber.Fiber<void> | undefined;
}

export interface ObjectDatabaseService {
  /** The object's client for the executor and Better Auth, held open until the caller's scope closes. */
  readonly sql: Effect.Effect<Context.Context<SqlServices>, never, Scope.Scope>;
}

/**
 * The calling Durable Object's connections. Absent in Worker events, whose connections belong
 * to the event.
 */
export class ObjectDatabase extends Context.Service<ObjectDatabase, ObjectDatabaseService>()(
  "executor/cloud/ObjectDatabase",
) {}

/**
 * Connections are named `executor <owner>`, truncated to Postgres's 63-byte limit, so
 * `pg_stat_activity` and PgBouncer attribute them to their object.
 */
const applicationName = (owner: string) => `executor ${owner}`.slice(0, 63);

/**
 * Resolve the connection binding during Worker initialization; the returned function makes one
 * object's database. A window opens on the first call that uses the database. The pool opens
 * connections in their own fibers; each `sql.connect` is reported to the most recent call still
 * holding the window, under the span that asked for the database. Transactions reserve one of the
 * window's connections; other calls use the rest and never join the transaction. A connection
 * the server drops is replaced on its next use, by the pool itself. Opening a connection gets a
 * second attempt when the first fails or times out ({@link cloudDatabasePool}). When the last
 * call ends, the window closes after {@link idleWindow}; the next call opens a new one. A caller
 * that gives up a connection retires the window instead: later calls open a new one, and the
 * retired window closes as soon as its last call ends, closing that connection with it. A call
 * that never ends therefore keeps its retired window open, and the object's windows together can
 * then hold more than {@link objectConnectionLimit} connections; nothing exercises that yet. Workerd
 * has no teardown hook for evicted objects; eviction drops their sockets.
 */
export const cloudObjectDatabase = Effect.gen(function* () {
  const connection = yield* cloudDatabaseConnection;
  return Effect.fn(function* (owner: string) {
    // Owned by the object for its whole life; only windows are ever closed.
    const root = Scope.makeUnsafe();
    const lock = yield* Semaphore.make(1);
    let window: ActiveWindow | undefined;
    const callers: Array<Caller> = [];
    // The pool captures the context it was built in; route their spans to a live caller instead.
    const callerTracer = (opener: Caller) =>
      Tracer.make({
        span: (options) => {
          const caller = callers.at(-1) ?? opener;
          return caller.tracer.span({ ...options, parent: caller.parent });
        },
      });
    const currentCaller = Effect.gen(function* () {
      return {
        tracer: yield* Effect.tracer,
        parent: yield* Effect.option(Effect.currentParentSpan),
      } satisfies Caller;
    });

    // Later calls open a new window; this one closes once its current callers are done.
    const retire = (retiring: ActiveWindow) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          if (window === retiring) window = undefined;
          return retiring.leases === 0 ? Scope.close(retiring.scope, Exit.void) : Effect.void;
        }),
      );

    const open = Effect.gen(function* () {
      const url = yield* connection.connectionString;
      const scope = yield* Scope.fork(root, "sequential");
      // Forked before the pool, so it closes after the pool has shut down.
      const reservations = yield* Scope.fork(scope, "sequential");
      const opener = yield* currentCaller;
      return yield* Effect.gen(function* () {
        const sql = yield* Layer.buildWithScope(
          cloudDatabasePool({
            url,
            maxConnections: objectConnectionLimit,
            idleTimeout: idleWindow,
            applicationName: applicationName(owner),
          }),
          scope,
        ).pipe(
          // Building opens no connection: the pool connects on first use.
          Effect.orDie,
        );
        const opened: ActiveWindow = {
          sql: Context.add(sql, ConnectionReservations, {
            scope: reservations,
            retire: Effect.suspend(() => retire(opened)),
          }),
          scope,
          leases: 0,
          idle: undefined,
        };
        return opened;
      }).pipe(
        Effect.withTracer(callerTracer(opener)),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    }).pipe(Effect.withSpan("database.object.open"));

    const close = (expired: ActiveWindow) =>
      Effect.suspend(() => {
        if (window !== expired || expired.leases > 0) return Effect.void;
        window = undefined;
        return Scope.close(expired.scope, Exit.void);
      });

    const release = ([leased, caller]: readonly [ActiveWindow, Caller]) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          callers.splice(callers.lastIndexOf(caller), 1);
          leased.leases -= 1;
          if (leased.leases > 0) return;
          // A retired window closes once its last caller is done.
          if (window !== leased) return yield* Scope.close(leased.scope, Exit.void);
          leased.idle = yield* Effect.sleep(idleWindow).pipe(
            Effect.andThen(lock.withPermits(1)(close(leased))),
            Effect.forkIn(root),
          );
        }),
      );

    const lease = Effect.acquireRelease(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const caller = yield* currentCaller;
          const current = window ?? (window = yield* open);
          current.leases += 1;
          callers.push(caller);
          const idle = current.idle;
          current.idle = undefined;
          if (idle !== undefined) yield* Fiber.interrupt(idle);
          return [current, caller] as const;
        }),
      ),
      release,
    );

    return ObjectDatabase.of({ sql: Effect.map(lease, ([leased]) => leased.sql) });
  });
});
