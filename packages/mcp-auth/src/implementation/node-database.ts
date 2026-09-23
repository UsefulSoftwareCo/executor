/** Promise boundary required by Better Auth's Kysely driver. */
import { PgliteClient } from "@effect/sql-pglite";
import { Effect, Exit, Scope, Schema } from "effect";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
} from "kysely";
/** A native auth database operation failed; driver details remain private. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "AuthDatabaseUnavailable",
  { stage: Schema.Literal("query") },
) {}

/**
 * Reserve Effect's connection for each Kysely checkout, including its entire
 * transaction. Raw PGlite access is safe only while this reservation is held.
 * Auth queries cannot join or commit another SDK operation's transaction.
 * The host owns the engine; Kysely releases reservations, not the engine.
 */
export const makeAuthDatabase = Effect.gen(function* () {
  const client = yield* PgliteClient.PgliteClient;
  const owner = yield* Effect.scope;
  const releases = new Map<DatabaseConnection, () => Promise<void>>();
  const driver: Driver = {
    init: () => Effect.runPromise(Effect.void),
    acquireConnection: (options) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* Scope.fork(owner, "sequential");
          yield* client.reserve.pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          const connection: DatabaseConnection = {
            executeQuery: <R>(query: CompiledQuery) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: () => client.pglite.query<R>(query.sql, [...query.parameters]),
                  catch: () => new DatabaseUnavailable({ stage: "query" }),
                }).pipe(
                  Effect.map((result) => ({
                    rows: result.rows,
                    ...(result.affectedRows === undefined
                      ? {}
                      : { numAffectedRows: BigInt(result.affectedRows) }),
                  })),
                ),
              ),
            async *streamQuery<R>(query: CompiledQuery) {
              yield await connection.executeQuery<R>(query);
            },
          };
          releases.set(connection, () => Effect.runPromise(Scope.close(scope, Exit.void)));
          return connection;
        }),
        options,
      ),
    beginTransaction: (connection, settings) =>
      Effect.runPromise(
        Effect.promise(() =>
          connection.executeQuery(
            CompiledQuery.raw(
              [
                "begin",
                settings.isolationLevel === undefined
                  ? ""
                  : `isolation level ${settings.isolationLevel}`,
                settings.accessMode ?? "",
              ].join(" "),
            ),
          ),
        ).pipe(Effect.asVoid),
      ),
    commitTransaction: (connection) =>
      Effect.runPromise(
        Effect.promise(() => connection.executeQuery(CompiledQuery.raw("commit"))).pipe(
          Effect.asVoid,
        ),
      ),
    rollbackTransaction: (connection) =>
      Effect.runPromise(
        Effect.promise(() => connection.executeQuery(CompiledQuery.raw("rollback"))).pipe(
          Effect.asVoid,
        ),
      ),
    releaseConnection: (connection) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const release = releases.get(connection);
          if (release !== undefined) {
            releases.delete(connection);
            yield* Effect.promise(release);
          }
        }),
      ),
    destroy: () =>
      Effect.runPromise(
        Effect.forEach(
          releases.keys(),
          (connection) => Effect.promise(() => driver.releaseConnection(connection)),
          { discard: true },
        ),
      ),
  };
  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Kysely<unknown>({
          dialect: {
            createDriver: () => driver,
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
          },
        }),
    ),
    (db) => Effect.promise(() => db.destroy()),
  );
});
