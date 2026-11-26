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
  type cloudDatabaseConnection,
  cloudDatabasePool,
  type cloudDirectDatabaseConnection,
} from "./database.ts";

const idleWindow = Duration.seconds(120);

export const objectConnectionLimit = 4;

export type SqlServices =
  | PgClient.PgClient
  | SqlClient.SqlClient
  | ConnectionReservations
  | OpenedConnections;

interface Caller {
  readonly tracer: Tracer.Tracer;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

interface ActiveWindow {
  readonly sql: Context.Context<SqlServices>;
  readonly scope: Scope.Closeable;
  leases: number;
  idle: Fiber.Fiber<void> | undefined;
}

export interface ObjectDatabaseService {
  readonly sql: Effect.Effect<Context.Context<SqlServices>, never, Scope.Scope>;
}

export class ObjectDatabase extends Context.Service<ObjectDatabase, ObjectDatabaseService>()(
  "executor/cloud/ObjectDatabase",
) {}

const applicationName = (owner: string) => `executor ${owner}`.slice(0, 63);

export const cloudObjectDatabase = Effect.fn(function* (
  route: typeof cloudDatabaseConnection | typeof cloudDirectDatabaseConnection,
) {
  const connection = yield* route;
  return Effect.fn(function* (owner: string, linger: Duration.Duration = idleWindow) {
    const root = Scope.makeUnsafe();
    const lock = yield* Semaphore.make(1);
    let window: ActiveWindow | undefined;
    const callers: Array<Caller> = [];
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
      const reservations = yield* Scope.fork(scope, "sequential");
      const opener = yield* currentCaller;
      return yield* Effect.gen(function* () {
        const sql = yield* Layer.buildWithScope(
          cloudDatabasePool({
            url,
            route: connection.route,
            maxConnections: objectConnectionLimit,
            idleTimeout: idleWindow,
            applicationName: applicationName(owner),
            statementGroups: true,
          }),
          scope,
        ).pipe(Effect.orDie);
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
          if (window !== leased) return yield* Scope.close(leased.scope, Exit.void);
          if (Duration.isZero(linger)) return yield* close(leased);
          leased.idle = yield* Effect.sleep(linger).pipe(
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
