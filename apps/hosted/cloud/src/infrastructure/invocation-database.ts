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

export const invocationConnectionLimit = 2;

export class InvocationDatabase extends Context.Service<
  InvocationDatabase,
  Effect.Effect<Context.Context<SqlServices>, SqlError.SqlError>
>()("executor/cloud/InvocationDatabase") {}

export const cloudInvocationDatabase = Layer.effect(
  InvocationDatabase,
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    return yield* makeExecutionMemo(
      Effect.gen(function* () {
        const object = yield* Effect.serviceOption(ObjectDatabase);
        if (Option.isSome(object)) return yield* object.value.sql;
        const url = yield* connection.connectionString;
        const reservations = yield* Scope.fork(yield* Effect.scope, "sequential");
        const sql = yield* Layer.build(
          cloudDatabasePool({
            url,
            route: connection.route,
            maxConnections: invocationConnectionLimit,
            applicationName: "executor event",
          }),
        );
        return Context.add(sql, ConnectionReservations, {
          scope: reservations,
          retire: Effect.void,
        });
      }).pipe(Effect.withSpan("runtime.cloud.database.initialize")),
    );
  }),
);

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
