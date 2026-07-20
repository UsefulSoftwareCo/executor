import type { FumaDBAdapter } from "../";
import type { AbstractQuery } from "../../query";
import type { JsonScalar } from "../../query/aggregate";
import {
  bucketFloor,
  coerceJsonValue,
  compareNullableAscending,
  computePercentiles,
  extractJsonPath,
  matchesJsonFilter,
} from "../../query/aggregate-eval";
import { ConditionType, type Condition } from "../../query/condition-builder";
import { toORM, type SimplifyFindOptions } from "../../query/orm";
import type { AnyColumn, AnySchema, AnyTable } from "../../schema";
import { Column } from "../../schema";
import type { FindManyOptions } from "../../query";

export type MemoryDatabase = Record<string, Record<string, unknown>[]>;

export interface MemoryAdapterOptions {
  readonly db?: MemoryDatabase;
}

const cloneValue = <T>(value: T): T => {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
};

const comparable = (value: unknown): unknown => {
  if (value instanceof Date) return value.getTime();
  return value;
};

const columnValue = (row: Record<string, unknown>, column: AnyColumn): unknown =>
  row[column.ormName];

const matchesCondition = (
  row: Record<string, unknown>,
  condition: Condition | undefined,
): boolean => {
  if (!condition) return true;

  switch (condition.type) {
    case ConditionType.And:
      return condition.items.every((item) => matchesCondition(row, item));
    case ConditionType.Or:
      return condition.items.some((item) => matchesCondition(row, item));
    case ConditionType.Not:
      return !matchesCondition(row, condition.item);
    case ConditionType.Compare:
      break;
    default:
      return false;
  }

  const left = comparable(columnValue(row, condition.a));
  const right =
    condition.b instanceof Column
      ? comparable(columnValue(row, condition.b))
      : comparable(condition.b);

  switch (condition.operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return left != null && right != null && left > right;
    case ">=":
      return left != null && right != null && left >= right;
    case "<":
      return left != null && right != null && left < right;
    case "<=":
      return left != null && right != null && left <= right;
    case "is":
      return right === null ? left == null : left === right;
    case "is not":
      return right === null ? left != null : left !== right;
    case "in":
      return Array.isArray(right) && right.includes(left);
    case "not in":
      return Array.isArray(right) && !right.includes(left);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    case "not contains":
      return !(typeof left === "string" && typeof right === "string" && left.includes(right));
    case "starts with":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "not starts with":
      return !(typeof left === "string" && typeof right === "string" && left.startsWith(right));
    case "ends with":
      return typeof left === "string" && typeof right === "string" && left.endsWith(right);
    case "not ends with":
      return !(typeof left === "string" && typeof right === "string" && left.endsWith(right));
  }
};

const tableRows = (db: MemoryDatabase, table: AnyTable): Record<string, unknown>[] => {
  db[table.ormName] ??= [];
  return db[table.ormName]!;
};

const applyDefaults = (
  table: AnyTable,
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  for (const column of Object.values(table.columns)) {
    if (Object.hasOwn(values, column.ormName) && values[column.ormName] !== undefined) {
      row[column.ormName] = cloneValue(values[column.ormName]);
      continue;
    }
    const defaultValue = column.generateDefaultValue();
    if (defaultValue !== undefined) row[column.ormName] = cloneValue(defaultValue);
    else if (column.isNullable) row[column.ormName] = null;
  }
  return row;
};

const selectRow = (
  table: AnyTable,
  row: Record<string, unknown>,
  select: SimplifyFindOptions<FindManyOptions>["select"],
): Record<string, unknown> => {
  if (select === true) return cloneValue(row);
  return Object.fromEntries(select.map((key) => [key, cloneValue(row[key as string])]));
};

export function memoryAdapter(options: MemoryAdapterOptions = {}): FumaDBAdapter {
  const db = options.db ?? {};

  return {
    name: "memory",
    createORM(schema): AbstractQuery<AnySchema> {
      let orm: AbstractQuery<AnySchema>;
      orm = toORM({
        tables: schema.tables,
        async count(table, v) {
          return tableRows(db, table).filter((row) => matchesCondition(row, v.where)).length;
        },
        async findFirst(table, v) {
          return (await this.findMany(table, { ...v, limit: 1 }))[0] ?? null;
        },
        async findMany(table, v) {
          if (v.join?.length) throw new Error("[FumaDB Memory] Joins are not supported.");
          let rows = tableRows(db, table).filter((row) => matchesCondition(row, v.where));

          for (const [column, direction] of [...(v.orderBy ?? [])].reverse()) {
            rows = [...rows].sort((a, b) => {
              const left = comparable(columnValue(a, column));
              const right = comparable(columnValue(b, column));
              if (left == null && right == null) return 0;
              if (left == null) return direction === "asc" ? -1 : 1;
              if (right == null) return direction === "asc" ? 1 : -1;
              if (left < right) return direction === "asc" ? -1 : 1;
              if (left > right) return direction === "asc" ? 1 : -1;
              return 0;
            });
          }

          const offset = v.offset ?? 0;
          const limited = rows.slice(offset, v.limit === undefined ? undefined : offset + v.limit);
          return limited.map((row) => selectRow(table, row, v.select));
        },
        async updateMany(table, v) {
          for (const row of tableRows(db, table)) {
            if (!matchesCondition(row, v.where)) continue;
            Object.assign(row, cloneValue(v.set));
          }
        },
        async upsert(table, v) {
          const existing = tableRows(db, table).find((row) => matchesCondition(row, v.where));
          if (existing) {
            Object.assign(existing, cloneValue(v.update));
            return;
          }
          await this.create(table, v.create);
        },
        async create(table, values) {
          const row = applyDefaults(table, values);
          tableRows(db, table).push(row);
          return cloneValue(row);
        },
        async createMany(table, values) {
          const idColumn = table.getIdColumn();
          return Promise.all(values.map((value) => this.create(table, value))).then((rows) =>
            rows.map((row) => ({ _id: row[idColumn.ormName] }))
          );
        },
        async deleteMany(table, v) {
          const rows = tableRows(db, table);
          db[table.ormName] = rows.filter((row) => !matchesCondition(row, v.where));
        },
        async jsonCount(table, { column, where, filter }) {
          return tableRows(db, table).filter(
            (row) =>
              matchesCondition(row, where) &&
              (!filter || matchesJsonFilter(row[column.ormName], filter)),
          ).length;
        },
        async jsonGroupCount(table, { column, where, filter, path, valueType }) {
          const counts = new Map<JsonScalar, number>();
          for (const row of tableRows(db, table)) {
            if (!matchesCondition(row, where)) continue;
            if (filter && !matchesJsonFilter(row[column.ormName], filter)) continue;
            const value = coerceJsonValue(
              extractJsonPath(row[column.ormName], path),
              valueType ?? "text",
            );
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [...counts.entries()].map(([value, count]) => ({ value, count }));
        },
        async jsonTimeBuckets(table, { column, where, filter, path, bucketMs }) {
          const counts = new Map<number, number>();
          for (const row of tableRows(db, table)) {
            if (!matchesCondition(row, where)) continue;
            if (filter && !matchesJsonFilter(row[column.ormName], filter)) continue;
            const raw = coerceJsonValue(extractJsonPath(row[column.ormName], path), "number");
            if (typeof raw !== "number") continue;
            const bucket = bucketFloor(raw, bucketMs);
            counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
          }
          return [...counts.entries()]
            .map(([bucket, count]) => ({ bucket, count }))
            .sort((a, b) => a.bucket - b.bucket);
        },
        async jsonStats(table, { column, where, filter, path, percentiles }) {
          const values: number[] = [];
          for (const row of tableRows(db, table)) {
            if (!matchesCondition(row, where)) continue;
            if (filter && !matchesJsonFilter(row[column.ormName], filter)) continue;
            const raw = coerceJsonValue(extractJsonPath(row[column.ormName], path), "number");
            if (typeof raw === "number") values.push(raw);
          }
          if (values.length === 0) return { count: 0, min: null, max: null, percentiles: [] };
          values.sort((a, b) => a - b);
          return {
            count: values.length,
            min: values[0]!,
            max: values[values.length - 1]!,
            percentiles: computePercentiles(values, percentiles ?? []),
          };
        },
        async jsonPage(table, { column, where, filter, orderBy, keyColumn, keyDirection, cursor, limit }) {
          const sortValue = (row: Record<string, unknown>, index: number): JsonScalar =>
            coerceJsonValue(
              extractJsonPath(row[column.ormName], orderBy[index]!.path),
              orderBy[index]!.valueType,
            );
          const keyOf = (row: Record<string, unknown>): string => String(row[keyColumn.ormName]);
          const keyDir = keyDirection === "desc" ? -1 : 1;

          let rows = tableRows(db, table).filter(
            (row) =>
              matchesCondition(row, where) &&
              (!filter || matchesJsonFilter(row[column.ormName], filter)),
          );

          rows = [...rows].sort((a, b) => {
            for (let index = 0; index < orderBy.length; index += 1) {
              const direction = orderBy[index]!.direction === "desc" ? -1 : 1;
              const compared =
                compareNullableAscending(sortValue(a, index), sortValue(b, index)) * direction;
              if (compared !== 0) return compared;
            }
            return compareNullableAscending(keyOf(a), keyOf(b)) * keyDir;
          });

          if (cursor) {
            const cursorValues = cursor.values.map((value, index) =>
              coerceJsonValue(value, orderBy[index]!.valueType),
            );
            rows = rows.filter((row) => {
              for (let index = 0; index < orderBy.length; index += 1) {
                const direction = orderBy[index]!.direction === "desc" ? -1 : 1;
                const compared =
                  compareNullableAscending(sortValue(row, index), cursorValues[index] ?? null) *
                  direction;
                if (compared !== 0) return compared > 0;
              }
              return compareNullableAscending(keyOf(row), cursor.key) * keyDir > 0;
            });
          }

          return rows.slice(0, limit).map((row) => selectRow(table, row, true));
        },
        async transaction<T>(run: (transactionInstance: AbstractQuery<AnySchema>) => Promise<T>) {
          const snapshot = cloneValue(db);
          try {
            return await run(orm);
          } catch (error) {
            for (const key of Object.keys(db)) delete db[key];
            Object.assign(db, snapshot);
            throw error;
          }
        },
      });
      return orm;
    },
    async getSchemaVersion() {
      return undefined;
    },
  };
}
