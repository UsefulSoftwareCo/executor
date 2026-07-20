import * as Drizzle from "drizzle-orm";
import type * as PostgreSQL from "drizzle-orm/pg-core";
import type { AbstractQuery, FindManyOptions } from "../../query";
import type {
  JsonFilter,
  JsonPath,
  JsonScalar,
  JsonValueType,
} from "../../query/aggregate";
import { coerceJsonValue, computePercentiles } from "../../query/aggregate-eval";
import { type Condition, ConditionType } from "../../query/condition-builder";
import { type SimplifyFindOptions, toORM } from "../../query/orm";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../../schema";
import type { SQLProvider } from "../../shared/providers";
import { type ColumnType, parseDrizzle, type TableType } from "./shared";

type P_TableType = PostgreSQL.PgTableWithColumns<PostgreSQL.TableConfig>;
type P_ColumnType = PostgreSQL.AnyPgColumn;
type P_DBType = PostgreSQL.PgDatabase<
  PostgreSQL.PgQueryResultHKT,
  Record<string, unknown>,
  Drizzle.TablesRelationalConfig
>;

const CREATE_MANY_BATCH_SIZE = 500;

function buildWhere(
  toDrizzle: (col: AnyColumn) => ColumnType,
  condition: Condition
): Drizzle.SQL | undefined {
  if (condition.type === ConditionType.Compare) {
    const left = toDrizzle(condition.a);
    const op = condition.operator;
    let right = condition.b;
    if (right instanceof Column) right = toDrizzle(right);
    let inverse = false;

    switch (op) {
      case "=":
        return Drizzle.eq(left, right);
      case "!=":
        return Drizzle.ne(left, right);
      case ">":
        return Drizzle.gt(left, right);
      case ">=":
        return Drizzle.gte(left, right);
      case "<":
        return Drizzle.lt(left, right);
      case "<=":
        return Drizzle.lte(left, right);
      case "in": {
        // @ts-expect-error -- skip type check
        return Drizzle.inArray(left, right);
      }
      case "not in":
        // @ts-expect-error -- skip type check
        return Drizzle.notInArray(left, right);
      case "is":
        return right === null ? Drizzle.isNull(left) : Drizzle.eq(left, right);
      case "is not":
        return right === null
          ? Drizzle.isNotNull(left)
          : Drizzle.ne(left, right);
      case "not contains":
        inverse = true;
      case "contains":
        right =
          typeof right === "string"
            ? `%${right}%`
            : Drizzle.sql`concat('%', ${right}, '%')`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);
      case "not ends with":
        inverse = true;
      case "ends with":
        right =
          typeof right === "string"
            ? `%${right}`
            : Drizzle.sql`concat('%', ${right})`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);
      case "not starts with":
        inverse = true;
      case "starts with":
        right =
          typeof right === "string"
            ? `${right}%`
            : Drizzle.sql`concat(${right}, '%')`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);

      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  if (condition.type === ConditionType.And)
    return Drizzle.and(
      ...condition.items.map((item) => buildWhere(toDrizzle, item))
    );

  if (condition.type === ConditionType.Not) {
    const result = buildWhere(toDrizzle, condition.item);
    if (!result) return;

    return Drizzle.not(result);
  }

  return Drizzle.or(
    ...condition.items.map((item) => buildWhere(toDrizzle, item))
  );
}

function mapValues(
  values: Record<string, unknown>,
  table: AnyTable
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const column of Object.values(table.columns)) {
    out[column.names.drizzle] = values[column.ormName];
  }

  return out;
}

function mapQueryResult(table: AnyTable, result: Record<string, unknown>) {
  const out: Record<string, unknown> = {};

  for (const k in result) {
    const value = result[k];

    if (k in table.relations) {
      const relation = table.relations[k];

      if (relation.type === "many") {
        out[k] = (value as Record<string, unknown>[]).map((v) =>
          mapQueryResult(relation.table, v)
        );
        continue;
      }

      out[k] = value ? mapQueryResult(relation.table, value as any) : null;
      continue;
    }

    const col = table.getColumnByName(k, "drizzle");
    if (!col) continue;
    out[col.ormName] = value;
  }

  return out;
}

// TODO: Support binary data in relation queries, because Drizzle doesn't support it: https://github.com/drizzle-team/drizzle-orm/issues/3497
/**
 * Require drizzle query mode, make sure to configure it first. (including the `schema` option)
 */
export function fromDrizzle(
  schema: AnySchema,
  _db: unknown,
  provider: SQLProvider,
  interactiveTransactions: boolean = true,
  maxBoundParameters?: number
): AbstractQuery<AnySchema> {
  const [db, drizzleTables] = parseDrizzle(_db);

  async function executeRaw(statement: string) {
    const target = db as unknown as {
      run?: (query: Drizzle.SQL) => unknown;
      execute?: (query: Drizzle.SQL) => Promise<unknown>;
    };
    const query = Drizzle.sql.raw(statement);

    if (target.run) {
      await target.run(query);
      return;
    }

    if (target.execute) {
      await target.execute(query);
      return;
    }

    throw new Error("[FumaDB Drizzle] Database cannot execute raw transaction statements.");
  }

  function toDrizzle(v: AnyTable): TableType {
    const out = drizzleTables[v.names.drizzle];
    if (out) return out;

    throw new Error(
      `[FumaDB Drizzle] Unknown table name ${v.names.drizzle}, is it included in your Drizzle schema?`
    );
  }

  function toDrizzleColumn(v: AnyColumn): ColumnType {
    const table = toDrizzle(v.table!);
    const out = table[v.names.drizzle];
    if (out) return out;

    throw new Error(
      `[FumaDB Drizzle] Unknown column name ${v.names.drizzle} in ${v.table.names.drizzle}.`
    );
  }

  // Drizzle Queries doesn't support renaming fields with `mapWith` because https://github.com/drizzle-team/drizzle-orm/issues/1157
  // we need to map the result on JS instead of relying on Drizzle
  function buildQueryConfig(
    table: AnyTable,
    options: SimplifyFindOptions<FindManyOptions>
  ) {
    const columns: Record<string, boolean> = {};
    const select = options.select;

    if (select === true) {
      for (const col of Object.values(table.columns)) {
        columns[col.names.drizzle] = true;
      }
    } else {
      for (const k of select) {
        columns[table.columns[k].names.drizzle] = true;
      }
    }

    const out: Drizzle.DBQueryConfig<"many" | "one", boolean> = {
      columns,
      limit: options.limit,
      offset: options.offset,
      where: options.where
        ? buildWhere(toDrizzleColumn, options.where)
        : undefined,
      orderBy: options.orderBy?.map(([item, mode]) =>
        mode === "asc"
          ? Drizzle.asc(toDrizzleColumn(item))
          : Drizzle.desc(toDrizzleColumn(item))
      ),
    };

    if (options.join) {
      out.with = {};

      for (const join of options.join) {
        if (join.options === false) continue;

        out.with[join.relation.name] = buildQueryConfig(
          join.relation.table,
          join.options
        );
      }
    }

    return out;
  }

  // --- JSON-document aggregation helpers ----------------------------------
  // Extract a JSON path as a typed SQL expression. SQLite `json_extract` is
  // natively typed; Postgres `#>>` returns text and needs explicit casts.
  function jsonExtractSql(
    jsonColumn: ColumnType,
    path: JsonPath,
    valueType: JsonValueType,
  ): Drizzle.SQL {
    if (provider === "postgresql") {
      // Build a `text[]` array literal with each segment double-quoted so a
      // segment containing a comma (the array element separator) descends the
      // intended key instead of splitting into two. Inside a quoted element a
      // backslash and a double-quote must be backslash-escaped.
      const pgPath = `{${path
        .map((segment) => `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",")}}`;
      const text = Drizzle.sql`(${jsonColumn} #>> ${pgPath})`;
      if (valueType === "number") return Drizzle.sql`${text}::numeric`;
      if (valueType === "boolean") return Drizzle.sql`${text}::boolean`;
      return text;
    }
    // Build a quoted SQLite JSON path (`$."seg1"."seg2"`) so a segment
    // containing a dot (the path separator) is treated as one key. Inside a
    // quoted segment an embedded backslash or double-quote is backslash-escaped.
    const jsonPath = `$${path
      .map((segment) => `."${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join("")}`;
    return Drizzle.sql`json_extract(${jsonColumn}, ${jsonPath})`;
  }

  // Escape LIKE wildcards (`%`, `_`) and the escape character itself so the
  // value matches literally, matching the memory adapter's
  // includes/startsWith/endsWith. Paired with an explicit `escape '\'` clause.
  function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  function jsonCompareSql(
    operator: string,
    expr: Drizzle.SQL,
    value: JsonScalar,
  ): Drizzle.SQL {
    switch (operator) {
      case "=":
        return Drizzle.eq(expr, value);
      case "!=":
        return Drizzle.ne(expr, value);
      case ">":
        return Drizzle.gt(expr, value);
      case ">=":
        return Drizzle.gte(expr, value);
      case "<":
        return Drizzle.lt(expr, value);
      case "<=":
        return Drizzle.lte(expr, value);
      case "contains": {
        const escaped = escapeLikePattern(String(value));
        return Drizzle.sql`${expr} like ${`%${escaped}%`} escape '\\'`;
      }
      case "starts with": {
        const escaped = escapeLikePattern(String(value));
        return Drizzle.sql`${expr} like ${`${escaped}%`} escape '\\'`;
      }
      case "ends with": {
        const escaped = escapeLikePattern(String(value));
        return Drizzle.sql`${expr} like ${`%${escaped}`} escape '\\'`;
      }
      default:
        throw new Error(`[FumaDB Drizzle] Unsupported JSON operator: ${operator}`);
    }
  }

  function buildJsonFilter(
    jsonColumn: ColumnType,
    filter: JsonFilter,
  ): Drizzle.SQL | undefined {
    if (filter.kind === "and") {
      return Drizzle.and(
        ...filter.items.map((item) => buildJsonFilter(jsonColumn, item)),
      );
    }
    if (filter.kind === "or") {
      if (filter.items.length === 0) return Drizzle.sql`1 = 0`;
      return Drizzle.or(
        ...filter.items.map((item) => buildJsonFilter(jsonColumn, item)),
      );
    }
    const expr = jsonExtractSql(jsonColumn, filter.path, filter.valueType);
    if (filter.kind === "array") {
      return filter.operator === "in"
        ? Drizzle.inArray(expr, filter.values as unknown[])
        : Drizzle.notInArray(expr, filter.values as unknown[]);
    }
    return jsonCompareSql(filter.operator, expr, filter.value);
  }

  function buildScopedConditions(
    jsonColumn: ColumnType,
    where: Condition | undefined,
    filter: JsonFilter | undefined,
  ): Drizzle.SQL | undefined {
    const parts: Drizzle.SQL[] = [];
    if (where) {
      const compiled = buildWhere(toDrizzleColumn, where);
      if (compiled) parts.push(compiled);
    }
    if (filter) {
      const compiled = buildJsonFilter(jsonColumn, filter);
      if (compiled) parts.push(compiled);
    }
    if (parts.length === 0) return undefined;
    return Drizzle.and(...parts);
  }

  return toORM({
    tables: schema.tables,
    async count(table, v) {
      return await db.$count(
        toDrizzle(table),
        v.where ? buildWhere(toDrizzleColumn, v.where) : undefined
      );
    },
    async findFirst(table, v) {
      const results = await this.findMany(table, {
        ...v,
        limit: 1,
      });

      return results[0] ?? null;
    },

    async upsert(table, v) {
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      let query = db
        .select({ id: drizzleTable[idField] })
        .from(drizzleTable)
        .limit(1);

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      const targetIds = await query.execute();

      if (targetIds.length > 0) {
        await db
          .update(drizzleTable)
          .set(mapValues(v.update, table))
          .where(Drizzle.eq(drizzleTable[idField], targetIds[0].id));
      } else {
        await this.createMany(table, [v.create]);
      }
    },
    async findMany(table, v) {
      return (
        await db.query[table.names.drizzle].findMany(buildQueryConfig(table, v))
      ).map((v) => mapQueryResult(table, v));
    },

    async updateMany(table, v) {
      const drizzleTable = toDrizzle(table);

      let query = db.update(drizzleTable).set(mapValues(v.set, table));

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      await query;
    },

    async create(table, values) {
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      values = mapValues(values, table);

      const returning: Record<string, ColumnType> = {};
      for (const column of Object.values(table.columns)) {
        returning[column.ormName] = drizzleTable[column.names.drizzle];
      }

      if (provider === "sqlite" || provider === "postgresql") {
        const result = await (db as unknown as P_DBType)
          .insert(drizzleTable as unknown as P_TableType)
          .values(values)
          .returning(returning as unknown as Record<string, P_ColumnType>);
        return result[0];
      }

      const obj = (
        await db.insert(drizzleTable).values(values).$returningId()
      )[0] as Record<string, unknown>;

      return (
        await db
          .select(returning)
          .from(drizzleTable)
          .where(Drizzle.eq(drizzleTable[idField], obj[idField]))
          .limit(1)
      )[0];
    },

    async createMany(table, values) {
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      values = values.map((v) => mapValues(v, table));
      // A multi-row insert binds (rows * columns) parameters in one statement.
      // Some engines cap bound parameters per query (Cloudflare D1: 100), so
      // size the batch by PARAMETER count, not row count — otherwise a wide
      // table (e.g. tools) overflows with "too many SQL variables". Engines
      // without a tight cap keep the row-count batch.
      const columnsPerRow = values.length > 0 ? Math.max(1, Object.keys(values[0]!).length) : 1;
      const batchSize = maxBoundParameters
        ? Math.max(1, Math.min(CREATE_MANY_BATCH_SIZE, Math.floor(maxBoundParameters / columnsPerRow)))
        : CREATE_MANY_BATCH_SIZE;
      const batches: (typeof values)[] = [];
      for (let i = 0; i < values.length; i += batchSize) {
        batches.push(values.slice(i, i + batchSize));
      }

      if (provider === "sqlite" || provider === "postgresql") {
        const out: { _id: unknown }[] = [];
        for (const batch of batches) {
          out.push(
            ...(await (db as unknown as P_DBType)
              .insert(drizzleTable as unknown as P_TableType)
              .values(batch)
              .returning({
                _id: (drizzleTable as unknown as P_TableType)[idField],
              })),
          );
        }
        return out;
      }

      const results: Record<string, unknown>[] = [];
      for (const batch of batches) {
        results.push(...(await db.insert(drizzleTable).values(batch).$returningId()));
      }
      return results.map((result) => ({ _id: result[idField] }));
    },

    async deleteMany(table, v) {
      const drizzleTable = toDrizzle(table);
      let query = db.delete(drizzleTable);

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      await query;
    },
    async jsonCount(table, { column, where, filter }) {
      const conditions = buildScopedConditions(toDrizzleColumn(column), where, filter);
      return await db.$count(toDrizzle(table), conditions);
    },
    async jsonGroupCount(table, { column, where, filter, path, valueType }) {
      const drizzleTable = toDrizzle(table);
      const jsonColumn = toDrizzleColumn(column);
      const groupExpr = jsonExtractSql(jsonColumn, path, valueType ?? "text");
      const conditions = buildScopedConditions(jsonColumn, where, filter);
      const rows = await db
        .select({ value: groupExpr, count: Drizzle.sql<number>`count(*)` })
        .from(drizzleTable)
        .where(conditions)
        .groupBy(groupExpr);
      return rows.map((row) => ({
        value: coerceJsonValue(row.value, valueType ?? "text"),
        count: Number(row.count),
      }));
    },
    async jsonTimeBuckets(table, { column, where, filter, path, bucketMs }) {
      const drizzleTable = toDrizzle(table);
      const jsonColumn = toDrizzleColumn(column);
      const valueExpr = jsonExtractSql(jsonColumn, path, "number");
      // `value - (value % bucket)` floors to the bucket start without relying
      // on integer division (SQLite binds numeric params as REAL, so `/` would
      // be float division). Matches `bucketFloor` for non-negative epochs.
      const bucketExpr = Drizzle.sql`(${valueExpr} - (${valueExpr} % ${bucketMs}))`;
      const conditions = buildScopedConditions(jsonColumn, where, filter);
      const rows = await db
        .select({ bucket: bucketExpr, count: Drizzle.sql<number>`count(*)` })
        .from(drizzleTable)
        .where(conditions)
        .groupBy(bucketExpr)
        .orderBy(bucketExpr);
      return rows.map((row) => ({ bucket: Number(row.bucket), count: Number(row.count) }));
    },
    async jsonStats(table, { column, where, filter, path, percentiles }) {
      const drizzleTable = toDrizzle(table);
      const jsonColumn = toDrizzleColumn(column);
      const valueExpr = jsonExtractSql(jsonColumn, path, "number");
      const conditions = buildScopedConditions(jsonColumn, where, filter);
      const aggregate = await db
        .select({
          count: Drizzle.sql<number>`count(${valueExpr})`,
          min: Drizzle.sql<number | null>`min(${valueExpr})`,
          max: Drizzle.sql<number | null>`max(${valueExpr})`,
        })
        .from(drizzleTable)
        .where(conditions);
      const summary = aggregate[0];
      const count = Number(summary?.count ?? 0);
      if (count === 0) return { count: 0, min: null, max: null, percentiles: [] };
      const min = summary?.min == null ? null : Number(summary.min);
      const max = summary?.max == null ? null : Number(summary.max);
      const fractions = percentiles ?? [];
      if (fractions.length === 0) return { count, min, max, percentiles: [] };

      if (provider === "postgresql") {
        const pctExpr = Drizzle.sql`percentile_cont(array[${Drizzle.sql.join(
          fractions.map((fraction) => Drizzle.sql`${fraction}`),
          Drizzle.sql`, `,
        )}]) within group (order by ${valueExpr})`;
        const pctRows = await db
          .select({ values: Drizzle.sql<number[]>`${pctExpr}` })
          .from(drizzleTable)
          .where(conditions);
        const values = pctRows[0]?.values ?? [];
        return {
          count,
          min,
          max,
          percentiles: fractions.map((fraction, index) => ({
            fraction,
            value: Number(values[index]),
          })),
        };
      }

      // SQLite has no percentile_cont, so compute over the projected values.
      const valueRows = await db
        .select({ value: valueExpr })
        .from(drizzleTable)
        .where(conditions)
        .orderBy(valueExpr);
      const sorted = valueRows
        .map((row) => row.value)
        .filter((value): value is number | string => value != null)
        .map((value) => Number(value))
        .filter((value) => !Number.isNaN(value))
        .sort((a, b) => a - b);
      return { count, min, max, percentiles: computePercentiles(sorted, fractions) };
    },
    async jsonPage(table, { column, where, filter, orderBy, keyColumn, keyDirection, cursor, limit }) {
      const drizzleTable = toDrizzle(table);
      const jsonColumn = toDrizzleColumn(column);
      const keyDrizzle = toDrizzleColumn(keyColumn);
      const scoped = buildScopedConditions(jsonColumn, where, filter);

      const orderExprs: Drizzle.SQL[] = orderBy.map((entry) => {
        const expr = jsonExtractSql(jsonColumn, entry.path, entry.valueType);
        // Mirror the memory adapter's null ordering (null first in asc, last in
        // desc, see compareNullableAscending). SQLite defaults to this; Postgres
        // defaults to the opposite, so make it explicit on both dialects.
        return entry.direction === "desc"
          ? Drizzle.sql`${expr} desc nulls last`
          : Drizzle.sql`${expr} asc nulls first`;
      });
      orderExprs.push(keyDirection === "desc" ? Drizzle.desc(keyDrizzle) : Drizzle.asc(keyDrizzle));

      // Keyset boundary terms with SQL three-valued-logic null handling. A naive
      // `expr > NULL` / `expr < NULL` is always unknown, which silently empties
      // every page once the cursor row's sort value is null. These mirror
      // compareNullableAscending so a nullable sort column paginates correctly.
      const eqTerm = (expr: Drizzle.SQL, cv: unknown): Drizzle.SQL =>
        cv == null ? Drizzle.isNull(expr) : Drizzle.eq(expr, cv);
      const strictTerm = (
        expr: Drizzle.SQL,
        cv: unknown,
        dir: "asc" | "desc",
      ): Drizzle.SQL | null => {
        if (dir === "asc") {
          // null is first: everything non-null is after a null cursor.
          return cv == null ? Drizzle.isNotNull(expr) : Drizzle.gt(expr, cv);
        }
        // desc, null last: nothing is strictly after a null cursor on this field;
        // and null rows fall after any non-null cursor value.
        if (cv == null) return null;
        return Drizzle.or(Drizzle.lt(expr, cv), Drizzle.isNull(expr)) ?? null;
      };

      let conditions = scoped;
      if (cursor) {
        const orTerms: Drizzle.SQL[] = [];
        for (let boundary = 0; boundary <= orderBy.length; boundary += 1) {
          const andTerms: Drizzle.SQL[] = [];
          for (let prior = 0; prior < boundary; prior += 1) {
            const entry = orderBy[prior]!;
            andTerms.push(
              eqTerm(
                jsonExtractSql(jsonColumn, entry.path, entry.valueType),
                cursor.values[prior] as unknown,
              ),
            );
          }
          if (boundary < orderBy.length) {
            const entry = orderBy[boundary]!;
            const expr = jsonExtractSql(jsonColumn, entry.path, entry.valueType);
            const strict = strictTerm(expr, cursor.values[boundary] as unknown, entry.direction);
            if (strict === null) continue;
            andTerms.push(strict);
          } else {
            andTerms.push(
              keyDirection === "asc"
                ? Drizzle.gt(keyDrizzle, cursor.key)
                : Drizzle.lt(keyDrizzle, cursor.key),
            );
          }
          const combined = Drizzle.and(...andTerms);
          if (combined) orTerms.push(combined);
        }
        const afterCursor = Drizzle.or(...orTerms);
        conditions = scoped && afterCursor ? Drizzle.and(scoped, afterCursor) : (afterCursor ?? scoped);
      }

      const projection: Record<string, ColumnType> = {};
      for (const tableColumn of Object.values(table.columns)) {
        projection[tableColumn.ormName] = drizzleTable[tableColumn.names.drizzle];
      }

      return await db
        .select(projection)
        .from(drizzleTable)
        .where(conditions)
        .orderBy(...orderExprs)
        .limit(limit);
    },
    async transaction(run) {
      // Some SQLite-compatible engines (Cloudflare D1) reject interactive
      // transactions — both raw BEGIN/COMMIT and the driver's `.transaction()`.
      // When disabled, run the operations directly against the same connection:
      // each statement auto-commits, so there is no atomic rollback (the
      // engine's constraint, not ours). libSQL/Postgres keep real transactions.
      if (!interactiveTransactions) {
        return run(fromDrizzle(schema, _db, provider, interactiveTransactions, maxBoundParameters));
      }

      if (provider === "sqlite") {
        await executeRaw("BEGIN");
        try {
          const result = await run(fromDrizzle(schema, _db, provider, interactiveTransactions, maxBoundParameters));
          await executeRaw("COMMIT");
          return result;
        } catch (e) {
          await executeRaw("ROLLBACK");
          throw e;
        }
      }

      return db.transaction((tx) =>
        run(fromDrizzle(schema, tx, provider, interactiveTransactions, maxBoundParameters))
      );
    },
  });
}
