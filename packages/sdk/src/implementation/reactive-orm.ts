/** Bind one SQL client and track coarse dependencies at the ORM boundary. */
import { Context, Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import type { ReactiveStore } from "@executor-js/reactivity";
import type { Orm, OrmError } from "fumadb-effect";
import type { AnySchema, AnyTable } from "fumadb-effect/schema";
import type { UpsertOptions, TableToColumnValues } from "fumadb-effect/query";

/** Private app storage adapter override. Unpartitioned ORM writes still invalidate every app reader. */
export const AppRecordPartition = Context.Reference<ReadonlyArray<string> | undefined>(
  "executor/storage/AppRecordPartition",
  {
    defaultValue: () => undefined,
  },
);

/** Conservatively include reachable relations whenever a query has joins. */
function reads(table: AnyTable | undefined, joined: boolean): ReadonlyArray<string> {
  const found = new Set<string>();
  const visit = (table: AnyTable | undefined) => {
    if (table === undefined || found.has(table.ormName)) return;
    found.add(table.ormName);
    if (joined) for (const relation of Object.values(table.relations)) visit(relation.table);
  };
  visit(table);
  return [...found];
}

/** Include transitive database cascades, even though they bypass ORM calls. */
function writes(
  schema: AnySchema,
  name: string,
  action: "onUpdate" | "onDelete" | "insert",
): ReadonlyArray<string> {
  const found = new Set([name]);
  if (action !== "insert") {
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const table of Object.values(schema.tables)) {
        if (found.has(table.ormName)) continue;
        for (const relation of Object.values(table.relations)) {
          if (relation.implied || relation.foreignKey === undefined) continue;
          if (
            found.has(relation.foreignKey.referencedTable.ormName) &&
            relation.foreignKey[action] !== "RESTRICT"
          ) {
            found.add(table.ormName);
            expanded = true;
          }
        }
      }
    }
  }
  return [...found];
}

/**
 * Capture the host driver without starting another Effect runtime. Transactions
 * keep their fiber-local SQL connection and publish only after commit. App record
 * operations use finer app/table keys in app-storage.ts. Unpartitioned writes
 * invalidate all app readers; direct SQL writes are intentionally outside this API.
 */
export function bindOrm<S extends AnySchema>(
  orm: Orm<S, SqlClient.SqlClient>,
  sql: SqlClient.SqlClient,
  reactive: ReactiveStore,
): Orm<S, never> {
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql);
  const trackedTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const connection = yield* Effect.serviceOption(sql.transactionService);
        if (Option.isSome(connection) && !(yield* reactive.inTransaction)) {
          return yield* new SqlError({
            reason: new UnknownError({
              cause: undefined,
              message:
                "Use the tracked ORM transaction boundary instead of wrapping it in an outer raw SQL transaction.",
              operation: "transaction",
            }),
          });
        }
        // Preserve the caller's cancellation policy. Cleanup transactions run in
        // finalizers and must not be made interruptible by this adapter.
        return yield* reactive.transaction(sql.withTransaction(restore(effect)));
      }),
    );
  const read = <A, E>(
    name: keyof S["tables"],
    joined: boolean,
    effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  ) =>
    provide(
      Effect.flatMap(AppRecordPartition, (partition) =>
        reactive.read(
          name !== "appRecords"
            ? reads(orm.schema.tables[String(name)], joined)
            : partition === undefined
              ? ["appRecords"]
              : [...partition, "appRecords:unpartitioned"],
          effect,
        ),
      ),
    );
  const write = <A, E>(
    name: keyof S["tables"],
    action: "onUpdate" | "onDelete" | "insert",
    effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  ) =>
    provide(
      Effect.flatMap(AppRecordPartition, (partition) =>
        trackedTransaction(
          reactive.write(
            name !== "appRecords"
              ? writes(orm.schema, String(name), action)
              : partition === undefined
                ? ["appRecords", "appRecords:unpartitioned"]
                : ["appRecords", ...partition],
            effect,
          ),
        ),
      ),
    );
  function upsert<T extends keyof S["tables"]>(
    table: T,
    options: UpsertOptions<S["tables"][T], false>,
  ): Effect.Effect<void, OrmError>;
  function upsert<T extends keyof S["tables"]>(
    table: T,
    options: UpsertOptions<S["tables"][T], true>,
  ): Effect.Effect<TableToColumnValues<S["tables"][T]>, OrmError>;
  function upsert<T extends keyof S["tables"]>(
    table: T,
    options: UpsertOptions<S["tables"][T], boolean>,
  ): Effect.Effect<void | TableToColumnValues<S["tables"][T]>, OrmError> {
    return options.returning === true
      ? write(table, "onUpdate", orm.upsert(table, { ...options, returning: true }))
      : write(table, "onUpdate", orm.upsert(table, { ...options, returning: false }));
  }
  return {
    schema: orm.schema,
    transaction: (effect) => provide(trackedTransaction(effect)),
    count: (table, options) => read(table, false, orm.count(table, options)),
    findFirst: (table, options) =>
      read(table, options?.join !== undefined, orm.findFirst(table, options)),
    findMany: (table, options) =>
      read(table, options?.join !== undefined, orm.findMany(table, options)),
    create: (table, values) => write(table, "insert", orm.create(table, values)),
    createMany: (table, values) => write(table, "insert", orm.createMany(table, values)),
    updateMany: (table, options) => write(table, "onUpdate", orm.updateMany(table, options)),
    deleteMany: (table, options) => write(table, "onDelete", orm.deleteMany(table, options)),
    upsert,
  };
}
