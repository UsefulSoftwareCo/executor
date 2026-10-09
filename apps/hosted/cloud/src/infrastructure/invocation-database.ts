/**
 * The SQL client one Worker event (or Durable Object call) uses for every database consumer:
 * the executor, hosted permission checks and Better Auth. A TLS login to PgBouncer costs about
 * 70 ms from a placed Worker, so consumers share one pool and sequential work reuses one connection.
 */
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option, Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import {
  ConnectionReservations,
  OpenedConnections,
  cloudDatabaseConnection,
  cloudDatabasePool,
} from "./database.ts";
import { ObjectDatabase, type SqlServices } from "./object-database.ts";

/**
 * Connections one Worker event may hold. The pool opens them on demand and reuses an idle one,
 * so sequential work, including Better Auth's session check followed by the executor, opens one.
 * The second exists so a Better Auth transaction and the executor never wait on each other,
 * which two separate one-connection pools guaranteed before.
 */
export const invocationConnectionLimit = 2;

export class InvocationDatabase extends Context.Service<
  InvocationDatabase,
  Effect.Effect<Context.Context<SqlServices>, SqlError.SqlError>
>()("executor/cloud/InvocationDatabase") {}

/**
 * One client per execution, closed with the event. A Durable Object lends its own held client
 * instead. Both come from {@link cloudDatabasePool}, so neither relies on session state, and both
 * make a failed connection attempt once more.
 */
export const cloudInvocationDatabase = Layer.effect(
  InvocationDatabase,
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    return yield* makeExecutionMemo(
      Effect.gen(function* () {
        const object = yield* Effect.serviceOption(ObjectDatabase);
        if (Option.isSome(object)) return yield* object.value.sql;
        const url = yield* connection.connectionString;
        // Forked before the pool, so it closes after the pool has shut down with the event.
        const reservations = yield* Scope.fork(yield* Effect.scope, "sequential");
        const sql = yield* Layer.build(
          cloudDatabasePool({ url, maxConnections: invocationConnectionLimit }),
        );
        return Context.add(sql, ConnectionReservations, {
          scope: reservations,
          retire: Effect.void,
        });
      }).pipe(Effect.withSpan("runtime.cloud.database.initialize")),
    );
  }),
);

/**
 * Run SQL on the client this invocation shares with Better Auth and the executor. Building it
 * opens no connection; a malformed URL is a deployment defect. The current span records whether
 * a connection opened while the SQL ran (`db.connect.opened`), so a caller's cold and warm
 * durations can be told apart. In a Durable Object a concurrent call's connection counts too.
 */
export const invocationSql = Effect.map(
  InvocationDatabase,
  (database) =>
    <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      database.pipe(
        Effect.orDie,
        Effect.flatMap((services) => {
          const opened = Context.get(services, OpenedConnections);
          const before = opened.count();
          return Effect.provideService(
            effect,
            SqlClient.SqlClient,
            Context.get(services, SqlClient.SqlClient),
          ).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                Effect.annotateCurrentSpan("db.connect.opened", opened.count() > before),
              ),
            ),
          );
        }),
      ),
);
