import { DateTime, Effect, Equal, Option } from "effect";
import { ConstraintError, SqlError } from "effect/sql/SqlError";
import type { AnyColumn } from "../../contracts/schema/column.ts";
import type { ForeignKey } from "../../contracts/schema/relation.ts";
import type { AnySchema } from "../../contracts/schema/schema.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";
import { Condition } from "../../contracts/condition.ts";
import type { OrmError } from "../../contracts/query.ts";
import type {
  CompiledFindOptions,
  CompiledUpsert,
  OrmAdapter,
  Row,
} from "../../contracts/query-adapter.ts";

type ColumnPair = readonly [AnyColumn, AnyColumn];

const pairsOf = (key: ForeignKey): ReadonlyArray<ColumnPair> => {
  const out: Array<ColumnPair> = [];
  for (let i = 0; i < key.columns.length; i++) {
    const column = key.columns[i];
    const referenced = key.referencedColumns[i];
    if (column === undefined || referenced === undefined) continue;
    out.push([column, referenced]);
  }
  return out;
};

const isAbsent = (value: unknown): boolean =>
  value === null || value === undefined || (Option.isOption(value) && Option.isNone(value));

const findAll = (where: Condition | undefined): CompiledFindOptions => ({
  select: true,
  computed: [],
  where,
  orderBy: undefined,
  join: undefined,
  limit: undefined,
  offset: undefined,
});

const violation = (key: ForeignKey, operation: string): SqlError => {
  const message = `foreign constraint failed ${key.name}`;
  return new SqlError({
    reason: new ConstraintError({ cause: new Error(message), message, operation }),
  });
};

const referencingCondition = (
  pairs: ReadonlyArray<ColumnPair>,
  targets: ReadonlyArray<Row>,
): Condition | undefined => {
  const items: Array<Condition> = [];
  for (const target of targets) {
    const conditions: Array<Condition> = [];
    let containsNull = false;
    for (const [column, referenced] of pairs) {
      const value = target[referenced.ormName];
      if (isAbsent(value)) {
        containsNull = true;
        break;
      }
      conditions.push(Condition.Compare({ column, operator: "=", value }));
    }
    if (!containsNull) items.push(Condition.And({ items: conditions }));
  }
  return items.length === 0 ? undefined : Condition.Or({ items });
};

const shouldSkipChecking = (
  key: ForeignKey,
  pairs: ReadonlyArray<ColumnPair>,
  inserts: ReadonlyArray<Row>,
  index: number,
): boolean => {
  const insert = inserts[index];
  if (insert === undefined) return true;
  const selfReferencing = key.table === key.referencedTable;
  for (let prior = 0; prior < index; prior++) {
    const earlier = inserts[prior];
    if (earlier === undefined) continue;
    if (pairs.every(([column]) => Equal.equals(insert[column.ormName], earlier[column.ormName])))
      return true;
    if (
      selfReferencing &&
      pairs.every(([column, referenced]) =>
        Equal.equals(insert[column.ormName], earlier[referenced.ormName]),
      )
    ) {
      return true;
    }
  }
  return false;
};

const visitKey = (table: AnyTable, id: unknown): string =>
  JSON.stringify([
    table.ormName,
    DateTime.isDateTime(id)
      ? `dt:${DateTime.toEpochMillis(id)}`
      : id instanceof Date
        ? `date:${id.getTime()}`
        : String(id),
  ]);

interface CascadeState {
  readonly deleted: Set<string>;
  readonly deletedIds: Map<string, Array<unknown>>;
  readonly updating: Set<string>;
}

const makeCascadeState = (): CascadeState => ({
  deleted: new Set<string>(),
  deletedIds: new Map<string, Array<unknown>>(),
  updating: new Set<string>(),
});

const scheduleDelete = (state: CascadeState, table: AnyTable, id: unknown): boolean => {
  const key = visitKey(table, id);
  if (state.deleted.has(key)) return false;
  state.deleted.add(key);
  if (isAbsent(id)) return true;
  const list = state.deletedIds.get(table.ormName);
  if (list === undefined) state.deletedIds.set(table.ormName, [id]);
  else list.push(id);
  return true;
};

const withoutDeleted = (state: CascadeState, table: AnyTable, where: Condition): Condition => {
  const ids = state.deletedIds.get(table.ormName);
  if (ids === undefined || ids.length === 0) return where;
  return Condition.And({
    items: [
      where,
      Condition.Compare({ column: table.getIdColumn(), operator: "not in", value: [...ids] }),
    ],
  });
};

export const createSoftForeignKey = <R>(
  schema: AnySchema,
  adapter: OrmAdapter<R>,
): OrmAdapter<R> => {
  const childForeignKeys = new Map<string, Array<ForeignKey>>();
  for (const table of Object.values(schema.tables)) {
    for (const key of table.foreignKeys) {
      const name = key.referencedTable.ormName;
      const list = childForeignKeys.get(name);
      if (list === undefined) childForeignKeys.set(name, [key]);
      else list.push(key);
    }
  }

  const exists = Effect.fnUntraced(function* (
    table: AnyTable,
    where: Condition,
    state: CascadeState,
  ) {
    const row = yield* adapter.findFirst(table, {
      ...findAll(withoutDeleted(state, table, where)),
      select: [table.getIdColumn().ormName],
    });
    return row !== null;
  });

  const generateDefaults = Effect.fnUntraced(function* (table: AnyTable, values: Row) {
    const out: Row = {};
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) out[name] = value;
    }
    for (const [name, column] of Object.entries(table.columns)) {
      if (Object.hasOwn(out, name)) continue;
      const generated = yield* column.generateDefault();
      if (generated !== undefined) out[name] = generated;
    }
    return out;
  });

  const checkForeignKeyOnInsert = Effect.fnUntraced(function* (
    key: ForeignKey,
    inserts: ReadonlyArray<Row>,
  ) {
    const pairs = pairsOf(key);
    const entries: Array<Condition> = [];
    for (let index = 0; index < inserts.length; index++) {
      const insert = inserts[index];
      if (insert === undefined) continue;
      if (shouldSkipChecking(key, pairs, inserts, index)) continue;

      const items: Array<Condition> = [];
      let containsNull = false;
      for (const [column, referenced] of pairs) {
        const value = insert[column.ormName];
        if (isAbsent(value)) {
          containsNull = true;
          break;
        }
        items.push(Condition.Compare({ column: referenced, operator: "=", value }));
      }
      if (!containsNull) entries.push(Condition.And({ items }));
    }

    if (entries.length === 0) return;
    const count = yield* adapter.count(key.referencedTable, {
      where: Condition.Or({ items: entries }),
    });
    if (count < entries.length) return yield* Effect.fail(violation(key, "insert"));
  });

  const touchedForeignKeys = (
    table: AnyTable,
    set: Row,
  ): {
    readonly constant: ReadonlyArray<ForeignKey>;
    readonly perRow: ReadonlyArray<ForeignKey>;
  } => {
    const constant: Array<ForeignKey> = [];
    const perRow: Array<ForeignKey> = [];
    for (const key of table.foreignKeys) {
      if (!key.columns.some((column) => set[column.ormName] !== undefined)) continue;
      if (key.columns.every((column) => set[column.ormName] !== undefined)) constant.push(key);
      else perRow.push(key);
    }
    return { constant, perRow };
  };

  const checkConstantForeignKeyOnUpdate = Effect.fnUntraced(function* (
    key: ForeignKey,
    set: Row,
    state: CascadeState,
  ) {
    const items: Array<Condition> = [];
    for (const [column, referenced] of pairsOf(key)) {
      const value = set[column.ormName];
      if (isAbsent(value)) return;
      items.push(Condition.Compare({ column: referenced, operator: "=", value }));
    }
    if (!(yield* exists(key.referencedTable, Condition.And({ items }), state)))
      return yield* Effect.fail(violation(key, "update"));
  });

  const checkPartialForeignKeysOnUpdate = Effect.fnUntraced(function* (
    keys: ReadonlyArray<ForeignKey>,
    set: Row,
    affected: ReadonlyArray<Row>,
    state: CascadeState,
  ) {
    if (keys.length === 0 || affected.length === 0) return;
    const rows = affected.map((row) => ({ ...row, ...set }));

    for (const key of keys) {
      const pairs = pairsOf(key);
      const seen = new Set<string>();
      for (const row of rows) {
        const items: Array<Condition> = [];
        let containsAbsent = false;
        const values: Array<unknown> = [];
        for (const [column, referenced] of pairs) {
          const value = row[column.ormName];
          if (isAbsent(value)) {
            containsAbsent = true;
            break;
          }
          values.push(value);
          items.push(Condition.Compare({ column: referenced, operator: "=", value }));
        }
        if (containsAbsent) continue;
        const marker = values.map(String).join("\u0000");
        if (seen.has(marker)) continue;
        seen.add(marker);
        if (!(yield* exists(key.referencedTable, Condition.And({ items }), state)))
          return yield* Effect.fail(violation(key, "update"));
      }
    }
  });

  const checkOwnKeysOnRows = Effect.fnUntraced(function* (
    table: AnyTable,
    set: Row,
    affected: ReadonlyArray<Row>,
    state: CascadeState,
  ) {
    if (affected.length === 0) return;
    const { constant, perRow } = touchedForeignKeys(table, set);
    for (const key of constant) yield* checkConstantForeignKeyOnUpdate(key, set, state);
    yield* checkPartialForeignKeysOnUpdate(perRow, set, affected, state);
  });

  const checkOwnKeysBeforeUpdate = Effect.fnUntraced(function* (
    table: AnyTable,
    set: Row,
    where: Condition | undefined,
    state: CascadeState,
  ) {
    const { constant, perRow } = touchedForeignKeys(table, set);
    if (perRow.length > 0) {
      const affected = yield* adapter.findMany(table, findAll(where));
      if (affected.length === 0) return;
      yield* checkPartialForeignKeysOnUpdate(perRow, set, affected, state);
      for (const key of constant) yield* checkConstantForeignKeyOnUpdate(key, set, state);
      return;
    }
    if (constant.length === 0) return;
    const idColumn = table.getIdColumn();
    const anyRow = yield* adapter.findFirst(table, {
      ...findAll(where),
      select: [idColumn.ormName],
    });
    if (anyRow === null) return;
    for (const key of constant) yield* checkConstantForeignKeyOnUpdate(key, set, state);
  });

  const foreignKeyOnUpdate: (
    key: ForeignKey,
    set: Row,
    targets: ReadonlyArray<Row>,
    state: CascadeState,
  ) => Effect.Effect<void, OrmError, R> = Effect.fnUntraced(function* (
    key: ForeignKey,
    set: Row,
    targets: ReadonlyArray<Row>,
    state: CascadeState,
  ) {
    const pairs = pairsOf(key);
    if (!pairs.some(([, referenced]) => set[referenced.ormName] !== undefined)) return;

    const affected = referencingCondition(pairs, targets);
    if (affected === undefined) return;

    if (key.onUpdate === "RESTRICT") {
      if (yield* exists(key.table, affected, state))
        return yield* Effect.fail(violation(key, "update"));
      return;
    }

    const mapped: Row = {};
    for (const [column, referenced] of pairs) {
      if (key.onUpdate === "SET NULL") {
        mapped[column.ormName] = null;
        continue;
      }
      const value = set[referenced.ormName];
      if (value !== undefined) mapped[column.ormName] = value;
    }
    if (Object.keys(mapped).length === 0) return;
    yield* updateManyImpl(key.table, mapped, affected, state);
  });

  const updateManyImpl: (
    table: AnyTable,
    set: Row,
    where: Condition | undefined,
    state: CascadeState,
    checkOwn?: boolean,
  ) => Effect.Effect<void, OrmError, R> = Effect.fnUntraced(function* (
    table: AnyTable,
    set: Row,
    where: Condition | undefined,
    state: CascadeState,
    checkOwn = false,
  ) {
    const foreignKeys = childForeignKeys.get(table.ormName);
    if (foreignKeys === undefined) {
      if (checkOwn) yield* checkOwnKeysBeforeUpdate(table, set, where, state);
      return yield* adapter.updateMany(table, { set, where });
    }

    const idColumn = table.getIdColumn();
    const found = yield* adapter.findMany(table, findAll(where));
    const targets: Array<Row> = [];
    const path: Array<string> = [];
    for (const row of found) {
      const marker = visitKey(table, row[idColumn.ormName]);
      if (state.updating.has(marker)) continue;
      path.push(marker);
      targets.push(row);
    }
    if (targets.length === 0) return;

    for (const marker of path) state.updating.add(marker);
    for (const key of foreignKeys) yield* foreignKeyOnUpdate(key, set, targets, state);
    if (checkOwn) yield* checkOwnKeysOnRows(table, set, targets, state);

    yield* adapter.updateMany(table, {
      set,
      where: Condition.Compare({
        column: idColumn,
        operator: "in",
        value: targets.map((target) => target[idColumn.ormName]),
      }),
    });
    for (const marker of path) state.updating.delete(marker);
  });

  const deleteManyImpl: (
    table: AnyTable,
    where: Condition | undefined,
    state: CascadeState,
  ) => Effect.Effect<void, OrmError, R> = Effect.fnUntraced(function* (
    table: AnyTable,
    where: Condition | undefined,
    state: CascadeState,
  ) {
    const foreignKeys = childForeignKeys.get(table.ormName);
    if (foreignKeys === undefined) return yield* adapter.deleteMany(table, { where });

    const idColumn = table.getIdColumn();
    const found = yield* adapter.findMany(table, findAll(where));
    const targets: Array<Row> = [];
    for (const row of found) {
      if (scheduleDelete(state, table, row[idColumn.ormName])) targets.push(row);
    }
    if (targets.length === 0) return;

    for (const key of foreignKeys) {
      const affected = referencingCondition(pairsOf(key), targets);
      if (affected === undefined) continue;

      if (key.onDelete === "CASCADE") {
        yield* deleteManyImpl(key.table, affected, state);
        continue;
      }
      if (key.onDelete === "SET NULL") {
        const set: Row = {};
        for (const column of key.columns) set[column.ormName] = null;
        yield* updateManyImpl(key.table, set, affected, state);
        continue;
      }
      if (yield* exists(key.table, affected, state))
        return yield* Effect.fail(violation(key, "delete"));
    }

    yield* adapter.deleteMany(table, {
      where: Condition.Compare({
        column: idColumn,
        operator: "in",
        value: targets.map((target) => target[idColumn.ormName]),
      }),
    });
  });

  const wrapped: OrmAdapter<R> = {
    tables: adapter.tables,
    count: adapter.count,
    findFirst: adapter.findFirst,
    findMany: adapter.findMany,
    transaction: adapter.transaction,

    create: Effect.fn("FumaDB.SoftForeignKey.create")(function* (table: AnyTable, values: Row) {
      if (table.foreignKeys.length === 0) return yield* adapter.create(table, values);
      const withDefaults = yield* generateDefaults(table, values);
      for (const key of table.foreignKeys) yield* checkForeignKeyOnInsert(key, [withDefaults]);
      return yield* adapter.create(table, withDefaults);
    }),

    createMany: Effect.fn("FumaDB.SoftForeignKey.createMany")(function* (
      table: AnyTable,
      values: ReadonlyArray<Row>,
    ) {
      if (table.foreignKeys.length === 0) return yield* adapter.createMany(table, values);
      const withDefaults: Array<Row> = [];
      for (const value of values) withDefaults.push(yield* generateDefaults(table, value));
      for (const key of table.foreignKeys) yield* checkForeignKeyOnInsert(key, withDefaults);
      return yield* adapter.createMany(table, withDefaults);
    }),

    updateMany: Effect.fn("FumaDB.SoftForeignKey.updateMany")(function* (
      table: AnyTable,
      options: { readonly where: Condition | undefined; readonly set: Row },
    ) {
      const touchesOwnKey = table.foreignKeys.some((key) =>
        key.columns.some((column) => options.set[column.ormName] !== undefined),
      );
      if (!touchesOwnKey && !childForeignKeys.has(table.ormName))
        return yield* adapter.updateMany(table, options);
      return yield* adapter.transaction(
        updateManyImpl(table, options.set, options.where, makeCascadeState(), true),
      );
    }),

    deleteMany: Effect.fn("FumaDB.SoftForeignKey.deleteMany")(function* (
      table: AnyTable,
      options: { readonly where: Condition | undefined },
    ) {
      if (!childForeignKeys.has(table.ormName)) return yield* adapter.deleteMany(table, options);
      return yield* adapter.transaction(deleteManyImpl(table, options.where, makeCascadeState()));
    }),

    upsert: Effect.fn("FumaDB.SoftForeignKey.upsert")(function* (
      table: AnyTable,
      options: CompiledUpsert,
    ) {
      if (table.foreignKeys.length === 0 && !childForeignKeys.has(table.ormName)) {
        return yield* adapter.upsert(table, options);
      }

      const target = yield* adapter.findFirst(table, findAll(options.where));
      if (target === null) {
        if (options.returning) return yield* wrapped.create(table, options.create);
        yield* wrapped.createMany(table, [options.create]);
        return undefined;
      }

      const idColumn = table.getIdColumn();
      const where = Condition.Compare({
        column: idColumn,
        operator: "=",
        value: target[idColumn.ormName],
      });
      yield* wrapped.updateMany(table, { where, set: options.update });
      if (!options.returning) return undefined;
      const row = yield* adapter.findFirst(table, findAll(where));
      return row ?? undefined;
    }),
  };

  return wrapped;
};
