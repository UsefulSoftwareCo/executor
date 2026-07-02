import * as Drizzle from "drizzle-orm";
import type * as PostgreSQL from "drizzle-orm/pg-core";
import type { AbstractQuery, FindManyOptions } from "../../query";
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
