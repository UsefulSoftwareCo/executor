import type { SqlBool } from "kysely";
import {
  type BinaryOperator,
  type ExpressionBuilder,
  type ExpressionWrapper,
  sql,
} from "kysely";
import type {
  AbstractQuery,
  AnySelectClause,
  FindManyOptions,
} from "../../query";
import { type Condition, ConditionType } from "../../query/condition-builder";
import {
  type CompiledJoin,
  type ORMAdapter,
  type SimplifyFindOptions,
  toORM,
} from "../../query/orm";
import { createSoftForeignKey } from "../../query/polyfills/foreign-key";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../../schema";
import { deserialize, serialize } from "../../schema/serialize";
import type { KyselyConfig } from "../../shared/config";
import type { SQLProvider } from "../../shared/providers";

function fullSQLName(column: AnyColumn) {
  return `${column.table.names.sql}.${column.names.sql}`;
}

export function buildWhere(
  condition: Condition,
  eb: ExpressionBuilder<any, any>,
  provider: SQLProvider
): ExpressionWrapper<any, any, SqlBool> {
  if (condition.type === ConditionType.Compare) {
    const left = condition.a;
    const op = condition.operator;
    let val = condition.b;

    if (!(val instanceof Column)) {
      val = serialize(val, left, provider);
    }

    let v: BinaryOperator;
    let rhs: unknown;

    switch (op) {
      case "contains":
        v = "like";
      case "not contains":
        v ??= "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val))}, '%')`
            : `%${val}%`;

        break;
      case "starts with":
        v = "like";
      case "not starts with":
        v ??= "not like";
        rhs =
          val instanceof Column
            ? sql`concat(${eb.ref(fullSQLName(val))}, '%')`
            : `${val}%`;

        break;
      case "ends with":
        v = "like";
      case "not ends with":
        v ??= "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val))})`
            : `%${val}`;
        break;
      default:
        v = op;
        rhs = val instanceof Column ? eb.ref(fullSQLName(val)) : val;
    }

    return eb(fullSQLName(left), v, rhs);
  }

  // Nested conditions
  if (condition.type === ConditionType.And) {
    return eb.and(condition.items.map((v) => buildWhere(v, eb, provider)));
  }

  if (condition.type === ConditionType.Not) {
    return eb.not(buildWhere(condition.item, eb, provider));
  }

  return eb.or(condition.items.map((v) => buildWhere(v, eb, provider)));
}

function mapSelect(
  select: AnySelectClause,
  table: AnyTable,
  options: {
    relation?: string;
    tableName?: string;
  } = {}
): string[] {
  const { relation, tableName = table.names.sql } = options;
  const out: string[] = [];
  const keys = Array.isArray(select) ? select : Object.keys(table.columns);

  for (const key of keys) {
    const name = relation ? `${relation}:${key}` : key;

    out.push(`${tableName}.${table.columns[key].names.sql} as ${name}`);
  }

  return out;
}

function extendSelect(original: AnySelectClause): {
  extend: (key: string) => void;
  compile: () => {
    result: AnySelectClause;
    extendedKeys: string[];
    /**
     * It doesn't create new object
     */
    removeExtendedKeys: (
      record: Record<string, unknown>
    ) => Record<string, unknown>;
  };
} {
  const select = Array.isArray(original) ? new Set(original) : true;
  const extendedKeys: string[] = [];

  return {
    extend(key) {
      if (select === true || select.has(key)) return;

      select.add(key);
      extendedKeys.push(key);
    },
    compile() {
      return {
        result: select instanceof Set ? Array.from(select) : true,
        extendedKeys,
        removeExtendedKeys(record) {
          for (const key of extendedKeys) {
            delete record[key];
          }
          return record;
        },
      };
    },
  };
}

// always use raw SQL names since Kysely is a query builder
export function fromKysely(
  schema: AnySchema,
  config: KyselyConfig
): AbstractQuery<AnySchema> {
  const {
    db: kysely,
    provider,
    relationMode = provider === "mssql" ? "@executor-js/fumadb" : "foreign-keys",
  } = config;

  /**
   * Transform object keys and encode values (e.g. for SQLite, date -> number)
   */
  function encodeValues(
    values: Record<string, unknown>,
    table: AnyTable,
    generateDefault: boolean
  ) {
    const result: Record<string, unknown> = {};

    for (const k in table.columns) {
      const col = table.columns[k];
      let value = values[k];

      if (generateDefault && value === undefined) {
        // prefer generating them on runtime to avoid SQLite's problem with column default value being ignored when insert
        value = col.generateDefaultValue();
      }

      if (value !== undefined) {
        result[col.names.sql] = serialize(value, col, provider);
      }
    }

    return result;
  }

  /**
   * Transform object keys and decode values
   */
  function decodeResult(result: Record<string, unknown>, table: AnyTable) {
    const output: Record<string, unknown> = {};

    for (const k in result) {
      const segs = k.split(":", 2);
      const value = result[k];

      if (segs.length === 1) {
        output[k] = deserialize(value, table.columns[k]!, provider);
      }

      if (segs.length === 2) {
        const [relationName, colName] = segs as [string, string];
        const relation = table.relations[relationName];
        if (relation === undefined) continue;
        const col = relation.table.columns[colName];
        if (col === undefined) continue;

        output[relationName] ??= {};
        const obj = output[relationName] as Record<string, unknown>;
        obj[colName] = deserialize(value, col, provider);
      }
    }

    return output;
  }

  async function runSubQueryJoin(
    records: Record<string, unknown>[],
    join: CompiledJoin
  ) {
    const { relation, options: joinOptions } = join;
    if (joinOptions === false) return;

    const selectBuilder = extendSelect(joinOptions.select);
    const root: Condition = {
      type: ConditionType.Or,
      items: [],
    };

    for (const record of records) {
      const condition: Condition = {
        type: ConditionType.And,
        items: [],
      };

      for (const [left, right] of relation.on) {
        selectBuilder.extend(right);

        condition.items.push({
          type: ConditionType.Compare,
          a: relation.table.columns[right],
          operator: "=",
          b: record[left],
        });
      }

      root.items.push(condition);
    }

    const compiledSelect = selectBuilder.compile();
    const subRecords = await findMany(relation.table, {
      ...joinOptions,
      select: compiledSelect.result,
      where: joinOptions.where
        ? {
            type: ConditionType.And,
            items: [root, joinOptions.where],
          }
        : root,
    });

    for (const record of records) {
      const filtered = subRecords.filter((subRecord) => {
        for (const [left, right] of relation.on) {
          if (record[left] !== subRecord[right]) return false;
        }

        compiledSelect.removeExtendedKeys(subRecord);
        return true;
      });

      record[relation.name] =
        relation.type === "one" ? (filtered[0] ?? null) : filtered;
    }
  }

  async function findMany(
    table: AnyTable,
    v: SimplifyFindOptions<FindManyOptions>
  ) {
    let query = kysely.selectFrom(table.names.sql);

    const where = v.where;
    if (where) {
      query = query.where((eb) => buildWhere(where, eb, provider));
    }

    if (v.offset !== undefined) {
      query = query.offset(v.offset);
    }

    if (v.limit !== undefined) {
      query = provider === "mssql" ? query.top(v.limit) : query.limit(v.limit);
    }

    if (v.orderBy) {
      for (const [col, mode] of v.orderBy) {
        query = query.orderBy(fullSQLName(col), mode);
      }
    }

    const selectBuilder = extendSelect(v.select);
    const mappedSelect: string[] = [];
    const subqueryJoins: CompiledJoin[] = [];

    for (const join of v.join ?? []) {
      const { options: joinOptions, relation } = join;
      if (joinOptions === false) continue;

      if (relation.type === "many" || joinOptions.join) {
        subqueryJoins.push(join);
        for (const [left] of relation.on) {
          selectBuilder.extend(left);
        }

        continue;
      }

      const targetTable = relation.table;
      const joinName = relation.name;
      // update select
      mappedSelect.push(
        ...mapSelect(joinOptions.select, targetTable, {
          relation: relation.name,
          tableName: joinName,
        })
      );

      query = query.leftJoin(`${targetTable.names.sql} as ${joinName}`, (b) =>
        b.on((eb) => {
          const conditions = [];
          for (const [left, right] of relation.on) {
            conditions.push(
              eb(
                `${table.names.sql}.${table.columns[left].names.sql}`,
                "=",
                eb.ref(`${joinName}.${targetTable.columns[right].names.sql}`)
              )
            );
          }

          if (joinOptions.where) {
            conditions.push(buildWhere(joinOptions.where, eb, provider));
          }

          return eb.and(conditions);
        })
      );
    }

    const compiledSelect = selectBuilder.compile();
    mappedSelect.push(...mapSelect(compiledSelect.result, table));

    const records = (await query.select(mappedSelect).execute()).map((v) =>
      decodeResult(v, table)
    );

    await Promise.all(
      subqueryJoins.map((join) => runSubQueryJoin(records, join))
    );
    for (const record of records) {
      compiledSelect.removeExtendedKeys(record);
    }

    return records;
  }

  let adapter: ORMAdapter = {
    tables: schema.tables,
    async count(table, { where }) {
      let query = await kysely
        .selectFrom(table.names.sql)
        .select(kysely.fn.countAll().as("count"));
      if (where) query = query.where((b) => buildWhere(where, b, provider));

      const result = await query.executeTakeFirstOrThrow();

      const count = Number(result.count);
      if (Number.isNaN(count))
        throw new Error(`Unexpected result for count, received: ${count}`);

      return count;
    },
    async create(table, values) {
      const rawTable = table;
      const insertValues = encodeValues(values, rawTable, true);
      const insert = kysely.insertInto(rawTable.names.sql).values(insertValues);

      if (provider === "mssql") {
        return decodeResult(
          await insert
            .output(
              mapSelect(true, rawTable, { tableName: "inserted" }) as any[]
            )
            .executeTakeFirstOrThrow(),
          rawTable
        );
      }

      if (provider === "postgresql" || provider === "sqlite") {
        return decodeResult(
          await insert
            .returning(mapSelect(true, rawTable))
            .executeTakeFirstOrThrow(),
          rawTable
        );
      }

      const idColumn = rawTable.getIdColumn();
      const idValue = insertValues[idColumn.names.sql];

      if (idValue == null)
        throw new Error(
          "cannot find value of id column, which is required for `create()`."
        );

      await insert.execute();
      return decodeResult(
        await kysely
          .selectFrom(rawTable.names.sql)
          .select(mapSelect(true, rawTable))
          .where(idColumn.names.sql, "=", idValue)
          .limit(1)
          .executeTakeFirstOrThrow(),
        rawTable
      );
    },
    async findFirst(table, v) {
      const records = await this.findMany(table, {
        ...v,
        limit: 1,
      });

      if (records.length === 0) return null;
      return records[0]!;
    },

    async findMany(table, v) {
      return findMany(table, v);
    },

    async updateMany(table, v) {
      let query = kysely
        .updateTable(table.names.sql)
        .set(encodeValues(v.set, table, false));
      if (v.where) {
        query = query.where((eb) => buildWhere(v.where!, eb, provider));
      }
      await query.execute();
    },
    async upsert(table, { where, update, create }) {
      if (provider === "mssql") {
        let query = kysely
          .updateTable(table.names.sql)
          .top(1)
          .set(encodeValues(update, table, false));

        if (where) query = query.where((b) => buildWhere(where, b, provider));
        const result = await query.executeTakeFirstOrThrow();

        if (result.numUpdatedRows === 0n)
          await this.createMany(table, [create]);
        return;
      }

      const idColumn = table.getIdColumn();
      let query = kysely
        .selectFrom(table.names.sql)
        .select([`${idColumn.names.sql} as id`]);
      if (where) query = query.where((b) => buildWhere(where, b, provider));
      const result = await query.limit(1).executeTakeFirst();

      if (result) {
        await kysely
          .updateTable(table.names.sql)
          .set(encodeValues(update, table, false))
          .where(idColumn.names.sql, "=", result.id)
          .execute();
      } else {
        await this.createMany(table, [create]);
      }
    },

    async createMany(table, values) {
      const encodedValues = values.map((v) => encodeValues(v, table, true));
      await kysely.insertInto(table.names.sql).values(encodedValues).execute();

      return encodedValues.map((value) => ({
        _id: value[table.getIdColumn().names.sql],
      }));
    },
    async deleteMany(table, { where }) {
      let query = kysely.deleteFrom(table.names.sql);
      if (where) {
        query = query.where((eb) => buildWhere(where, eb, provider));
      }
      await query.execute();
    },
    transaction(run) {
      return kysely.transaction().execute((ctx) => {
        const tx = fromKysely(schema, {
          ...config,
          db: ctx,
        });

        return run(tx);
      });
    },
  };

  if (relationMode === "@executor-js/fumadb")
    adapter = createSoftForeignKey(schema, {
      ...adapter,
      generateInsertValuesDefault(table, values) {
        const result: Record<string, unknown> = {};

        for (const k in table.columns) {
          const col = table.columns[k];

          if (values[k] === undefined) {
            result[k] = col.generateDefaultValue();
          } else {
            result[k] = values[k];
          }
        }

        return result;
      },
    });

  return toORM(adapter);
}
