/**
 * An in-memory {@link OrmAdapter} for tests.
 *
 * It stores rows in a `Map` per table and evaluates the compiled `Condition`
 * tree in JavaScript, so engine behaviour (the soft foreign key engine in
 * particular) can be tested without a database.
 *
 * What it models:
 * - SQL's three-valued logic: a comparison involving `NULL` is `UNKNOWN`, and
 *   a `WHERE` clause keeps a row only when the condition is true. `is` and
 *   `is not` are the null-aware operators.
 * - `select`, `where`, `orderBy`, `limit`, and `offset` on find operations.
 * - Column defaults through `column.generateDefault()`, like the SQL adapter.
 * - `transaction`, by snapshotting every table and restoring the snapshot when
 *   the effect fails. Nested calls take nested snapshots.
 *
 * What it does not model: joins (a join is a defect), unique constraints, type
 * coercion, and column value encoding.
 */
import { DateTime, Effect, Equal, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Condition, Operator } from "../../src/contracts/condition.ts";
import type {
  CompiledFindOptions,
  CompiledUpsert,
  OrmAdapter,
  Row,
} from "../../src/contracts/query-adapter.ts";
import type { AnySchema } from "../../src/contracts/schema/schema.ts";
import type { AnyTable } from "../../src/contracts/schema/table.ts";

/** Equality that understands the value types a column can hold. */
const equals = (rawA: unknown, rawB: unknown): boolean => {
  const a = unwrapSome(rawA);
  const b = unwrapSome(rawB);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return Equal.equals(a, b) || Object.is(a, b);
};

/** `-1`, `0`, `1`, or `undefined` when the two values cannot be ordered. */
/** `Option.some(x)` orders and compares as `x`. */
const unwrapSome = (value: unknown): unknown =>
  Option.isOption(value) && Option.isSome(value) ? value.value : value;

const order = (rawA: unknown, rawB: unknown): number | undefined => {
  const a = unwrapSome(rawA);
  const b = unwrapSome(rawB);
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) {
    const left = DateTime.toEpochMillis(a);
    const right = DateTime.toEpochMillis(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "bigint" && typeof b === "bigint") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (a instanceof Date && b instanceof Date) {
    const left = a.getTime();
    const right = b.getTime();
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return undefined;
};

const compareOrder = (operator: "<" | "<=" | ">" | ">=", a: unknown, b: unknown): boolean => {
  const result = order(a, b);
  if (result === undefined) return false;
  switch (operator) {
    case "<":
      return result < 0;
    case "<=":
      return result <= 0;
    case ">":
      return result > 0;
    case ">=":
      return result >= 0;
  }
};

const isNull = (value: unknown): boolean =>
  value === null || value === undefined || (Option.isOption(value) && Option.isNone(value));

/** SQL's three truth values. `undefined` is SQL `UNKNOWN`. */
type Truth = boolean | undefined;

const compareString = (operator: Operator, left: string, right: unknown): Truth => {
  if (typeof right !== "string") return undefined;
  switch (operator) {
    case "contains":
      return left.includes(right);
    case "not contains":
      return !left.includes(right);
    case "starts with":
      return left.startsWith(right);
    case "not starts with":
      return !left.startsWith(right);
    case "ends with":
      return left.endsWith(right);
    case "not ends with":
      return !left.endsWith(right);
    default:
      return undefined;
  }
};

/** Compare one column value, with SQL's rule that anything involving `NULL` is `UNKNOWN`. */
const compare = (operator: Operator, left: unknown, right: unknown): Truth => {
  // `is` / `is not` are the null-aware operators, so they always decide
  if (operator === "is") return isNull(left) && isNull(right) ? true : equals(left, right);
  if (operator === "is not") return !(isNull(left) && isNull(right) ? true : equals(left, right));
  if (isNull(left)) return undefined;

  switch (operator) {
    case "=":
    case "!=": {
      if (isNull(right)) return undefined;
      const same = equals(left, right);
      return operator === "=" ? same : !same;
    }
    case "<":
    case "<=":
    case ">":
    case ">=":
      return isNull(right) ? undefined : compareOrder(operator, left, right);
    case "in":
    case "not in": {
      if (!Array.isArray(right)) return undefined;
      const found = right.some((candidate) => equals(left, candidate));
      return operator === "in" ? found : !found;
    }
    default:
      return typeof left === "string" ? compareString(operator, left, right) : undefined;
  }
};

/**
 * Evaluate a compiled condition against one row, in SQL's three-valued logic.
 * `undefined` means `UNKNOWN`, which a `WHERE` clause treats as not matching.
 */
const evaluate = (condition: Condition, row: Row): Truth => {
  switch (condition._tag) {
    case "And": {
      let unknown = false;
      for (const item of condition.items) {
        const result = evaluate(item, row);
        if (result === false) return false;
        if (result === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case "Or": {
      let unknown = false;
      for (const item of condition.items) {
        const result = evaluate(item, row);
        if (result === true) return true;
        if (result === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    case "Not": {
      const result = evaluate(condition.item, row);
      return result === undefined ? undefined : !result;
    }
    case "Compare":
      return compare(condition.operator, row[condition.column.ormName], condition.value);
  }
};

/** A `WHERE` clause keeps a row only when the condition is true. */
const matches = (condition: Condition, row: Row): boolean => evaluate(condition, row) === true;

/** The in-memory adapter, plus helpers to seed and inspect the store. */
export interface MemoryAdapter extends OrmAdapter<never> {
  /** Write rows straight into a table, with no defaults and no foreign key checks. */
  readonly seed: (table: string, rows: ReadonlyArray<Row>) => void;
  /** Every stored row of a table, in insertion order. */
  readonly dump: (table: string) => ReadonlyArray<Row>;
  /** Remove every row of every table. */
  readonly clear: () => void;
}

/**
 * Build an in-memory adapter for `schema`.
 *
 * Rows are stored per table under the table's ORM name, with every column
 * present (missing columns are `null`). Stored rows are never mutated in
 * place, so a transaction snapshot stays valid.
 */
export const makeMemoryAdapter = (schema: AnySchema): MemoryAdapter => {
  const store = new Map<string, Array<Row>>();
  for (const name of Object.keys(schema.tables)) store.set(name, []);

  const rowsOf = (table: AnyTable): Array<Row> => {
    const found = store.get(table.ormName);
    if (found !== undefined) return found;
    const created: Array<Row> = [];
    store.set(table.ormName, created);
    return created;
  };

  /** Every column present; absent columns become `null`. */
  const normalize = (table: AnyTable, values: Row): Row => {
    const out: Row = {};
    for (const name of Object.keys(table.columns)) {
      const value = values[name];
      out[name] = value === undefined ? null : value;
    }
    return out;
  };

  const withDefaults = (table: AnyTable, values: Row): Effect.Effect<Row> =>
    Effect.gen(function* () {
      const out: Row = {};
      for (const [name, value] of Object.entries(values)) {
        if (value !== undefined) out[name] = value;
      }
      for (const [name, column] of Object.entries(table.columns)) {
        if (Object.hasOwn(out, name)) continue;
        const generated = yield* column.generateDefault();
        if (generated !== undefined) out[name] = generated;
      }
      return normalize(table, out);
    });

  const project = (row: Row, select: CompiledFindOptions["select"]): Row => {
    if (select === true) return { ...row };
    const out: Row = {};
    for (const name of select) out[String(name)] = row[String(name)];
    return out;
  };

  const matching = (table: AnyTable, where: Condition | undefined): Array<Row> => {
    const rows = rowsOf(table);
    return where === undefined ? rows.slice() : rows.filter((row) => matches(where, row));
  };

  const find = (table: AnyTable, options: CompiledFindOptions): Effect.Effect<Array<Row>> =>
    Effect.sync(() => {
      if (options.join !== undefined && options.join.length > 0) {
        throw new Error("the in-memory test adapter does not support joins.");
      }
      let rows = matching(table, options.where);
      const orderBy = options.orderBy;
      if (orderBy !== undefined) {
        rows = rows.slice().sort((a, b) => {
          for (const [column, direction] of orderBy) {
            const left = a[column.ormName];
            const right = b[column.ormName];
            if (isNull(left) && isNull(right)) continue;
            // a NULL sorts before any value
            const result = isNull(left) ? -1 : isNull(right) ? 1 : (order(left, right) ?? 0);
            if (result !== 0) return direction === "asc" ? result : -result;
          }
          return 0;
        });
      }
      if (options.offset !== undefined) rows = rows.slice(options.offset);
      if (options.limit !== undefined) rows = rows.slice(0, options.limit);
      return rows.map((row) => project(row, options.select));
    });

  const insert = (table: AnyTable, values: Row): Effect.Effect<Row> =>
    Effect.flatMap(withDefaults(table, values), (row) =>
      Effect.sync(() => {
        rowsOf(table).push(row);
        return { ...row };
      }),
    );

  const applyUpdate = (table: AnyTable, where: Condition | undefined, set: Row): number => {
    const rows = rowsOf(table);
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      if (where !== undefined && !matches(where, row)) continue;
      const next: Row = { ...row };
      for (const [name, value] of Object.entries(set)) {
        if (value === undefined) continue;
        next[name] = value;
      }
      // replace instead of mutating, so an earlier transaction snapshot stays intact
      rows[i] = next;
      updated++;
    }
    return updated;
  };

  const snapshot = (): Map<string, Array<Row>> => {
    const copy = new Map<string, Array<Row>>();
    for (const [name, rows] of store) copy.set(name, rows.slice());
    return copy;
  };

  const restore = (previous: Map<string, Array<Row>>): void => {
    store.clear();
    for (const [name, rows] of previous) store.set(name, rows);
  };

  return {
    tables: schema.tables,

    count: (table, options) => Effect.sync(() => matching(table, options.where).length),

    findMany: (table, options) => find(table, options),

    findFirst: (table, options) =>
      Effect.map(find(table, { ...options, limit: options.limit ?? 1 }), (rows) => rows[0] ?? null),

    create: (table, values) => insert(table, values),

    createMany: (table, values) =>
      Effect.gen(function* () {
        const idColumn = table.getIdColumn();
        const created: Array<{ readonly _id: unknown }> = [];
        for (const value of values) {
          const row = yield* insert(table, value);
          created.push({ _id: row[idColumn.ormName] });
        }
        return created;
      }),

    updateMany: (table, options) =>
      Effect.sync(() => void applyUpdate(table, options.where, options.set)),

    deleteMany: (table, options) =>
      Effect.sync(() => {
        const where = options.where;
        if (where === undefined) {
          store.set(table.ormName, []);
          return;
        }
        store.set(
          table.ormName,
          rowsOf(table).filter((row) => !matches(where, row)),
        );
      }),

    upsert: (table, options: CompiledUpsert) =>
      Effect.gen(function* () {
        const idColumn = table.getIdColumn();
        const existing = matching(table, options.where)[0];
        if (existing === undefined) {
          const row = yield* insert(table, options.create);
          return options.returning ? row : undefined;
        }
        const id = existing[idColumn.ormName];
        const rows = rowsOf(table);
        const index = rows.findIndex((row) => equals(row[idColumn.ormName], id));
        const target = rows[index];
        if (target === undefined) return undefined;
        const next: Row = { ...target };
        for (const [name, value] of Object.entries(options.update)) {
          if (value === undefined) continue;
          next[name] = value;
        }
        rows[index] = next;
        return options.returning ? { ...next } : undefined;
      }),

    transaction: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E | SqlError, R2> =>
      Effect.suspend(() => {
        const previous = snapshot();
        return Effect.onError(effect, () => Effect.sync(() => restore(previous)));
      }),

    seed: (table, rows) => {
      const found = schema.tables[table];
      if (found === undefined) throw new Error(`unknown table ${table}`);
      for (const row of rows) rowsOf(found).push(normalize(found, row));
    },

    dump: (table) => (store.get(table) ?? []).map((row) => ({ ...row })),

    clear: () => {
      for (const name of store.keys()) store.set(name, []);
    },
  };
};
