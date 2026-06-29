import type {
  AbstractQuery,
  AnySelectClause,
  FindManyOptions,
} from "../../query";
import { type Condition, ConditionType } from "../../query/condition-builder";
import { type SimplifyFindOptions, toORM } from "../../query/orm";
import { checkForeignKeyOnInsert } from "../../query/polyfills/foreign-key";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../../schema";
import type * as Prisma from "../../shared/prisma";
import type { PrismaConfig } from ".";

// TODO: implement comparing values with another table's columns
function buildWhere(condition: Condition): object {
  if (condition.type === ConditionType.Compare) {
    const column = condition.a;
    const value = condition.b;
    const name = column.names.prisma;

    if (value instanceof Column) {
      throw new Error(
        "Prisma adapter does not support comparing against another column at the moment.",
      );
    }

    switch (condition.operator) {
      case "=":
      case "is":
        return { [name]: value };
      case "!=":
      case "is not":
        return { [name]: { not: value } };
      case ">":
        return { [name]: { gt: value } };
      case ">=":
        return { [name]: { gte: value } };
      case "<":
        return { [name]: { lt: value } };
      case "<=":
        return { [name]: { lte: value } };
      case "in":
        return { [name]: { in: value } };
      case "not in":
        return { [name]: { notIn: value } };
      case "starts with":
        return { [name]: { startsWith: value } };
      case "not starts with":
        return { NOT: { [name]: { startsWith: value } } };
      case "contains":
        return { [name]: { contains: value } };
      case "not contains":
        return { NOT: { [name]: { contains: value } } };
      case "ends with":
        return { [name]: { endsWith: value } };
      case "not ends with":
        return { NOT: { [name]: { endsWith: value } } };
      default:
        throw new Error(`Unsupported operator: ${condition.operator}`);
    }
  }

  if (condition.type === ConditionType.And) {
    return {
      AND: condition.items.map(buildWhere),
    };
  }

  if (condition.type === ConditionType.Not) {
    return {
      NOT: buildWhere(condition.item),
    };
  }

  return {
    OR: condition.items.map(buildWhere),
  };
}

function mapSelect(select: AnySelectClause, table: AnyTable) {
  const out: Record<string, boolean> = {};

  if (select === true) {
    for (const col of Object.values(table.columns)) {
      out[col.names.prisma] = true;
    }
  } else {
    for (const col of select) {
      out[table.columns[col].names.prisma] = true;
    }
  }

  return out;
}

function mapOrderBy(orderBy: [column: AnyColumn, mode: "asc" | "desc"][]) {
  const out: Prisma.OrderBy = {};

  for (const [col, mode] of orderBy) {
    out[col.names.prisma] = mode;
  }

  return out;
}

function mapResult(result: Record<string, unknown>, table: AnyTable) {
  const out: Record<string, unknown> = {};

  for (const k in result) {
    const value = result[k];

    if (k in table.relations) {
      const relation = table.relations[k];
      if (relation.type === "many") {
        out[k] = (value as Record<string, unknown>[]).map((v) =>
          mapResult(v, relation.table),
        );
      } else {
        out[k] = value ? mapResult(value as any, relation.table) : null;
      }

      continue;
    }

    const col = table.getColumnByName(k, "prisma");
    if (col) out[col.ormName] = value;
  }

  return out;
}

export function fromPrisma(
  schema: AnySchema,
  config: PrismaConfig & {
    isTransaction?: boolean;
  },
): AbstractQuery<AnySchema> {
  const {
    provider,
    prisma,
    relationMode = provider === "mongodb" ? "prisma" : "foreign-keys",
    db: internalClient,
    isTransaction = false,
  } = config;

  // replace index with partial index to ignore null values
  // see https://github.com/prisma/prisma/issues/3387
  async function initMongoDB() {
    if (!internalClient || isTransaction) return;
    const db = internalClient.db();

    async function initCollection(table: AnyTable) {
      const collection = db.collection(table.names.mongodb);
      const indexes = await collection.indexes();

      for (const index of indexes) {
        if (!index.unique || !index.name || index.sparse) continue;

        await collection.dropIndex(index.name);
        await collection.createIndex(index.key, {
          name: index.name,
          unique: true,
          sparse: true,
        });
      }
    }

    await Promise.all(Object.values(schema.tables).map(initCollection));
  }

  let mapped: Map<string, string> | undefined;

  function getPrismaModel(table: AnyTable) {
    if (!mapped) {
      mapped = new Map();
      for (const key in prisma) {
        mapped.set(key.toLowerCase(), key);
      }
    }

    const modelName = mapped.get(table.names.prisma.toLowerCase());

    if (!modelName) {
      throw new Error(
        `Prisma client is missing model delegate "${table.names.prisma}" for table "${table.ormName}".`,
      );
    }

    return prisma[modelName]!;
  }

  const init = initMongoDB();

  function createFindOptions(
    table: AnyTable,
    v: SimplifyFindOptions<FindManyOptions>,
  ) {
    const where = v.where ? buildWhere(v.where) : undefined;
    const select: Record<string, unknown> = mapSelect(v.select, table);

    if (v.join) {
      for (const { relation, options: joinOptions } of v.join) {
        if (joinOptions === false) continue;

        select[relation.name] = createFindOptions(relation.table, joinOptions);
      }
    }

    return {
      where,
      select,
      skip: v.offset,
      take: v.limit,
      orderBy: v.orderBy ? mapOrderBy(v.orderBy) : undefined,
    };
  }

  function mapValues(
    table: AnyTable,
    values: Record<string, unknown>,
    generateDefault = false,
  ) {
    const out: Record<string, unknown> = {};

    for (const col of Object.values(table.columns)) {
      let value = values[col.ormName];
      if (value === undefined && generateDefault)
        value = col.generateDefaultValue();

      out[col.names.prisma] = value;
    }

    return out;
  }

  return toORM({
    tables: schema.tables,
    async count(table, v) {
      await init;
      const model = getPrismaModel(table);

      return (
        await model.count({
          select: {
            _all: true,
          },
          where: v.where ? buildWhere(v.where) : undefined,
        })
      )._all;
    },
    async findFirst(table, v) {
      await init;
      const model = getPrismaModel(table);
      const options = createFindOptions(table, v);
      delete options.take;

      const result = await model.findFirst({
        ...options,
        where: options.where!,
      });
      if (result) return mapResult(result, table);

      return null;
    },
    async findMany(table, v) {
      await init;
      const model = getPrismaModel(table);

      return (await model.findMany(createFindOptions(table, v))).map((v) =>
        mapResult(v, table),
      );
    },
    async updateMany(table, v) {
      await init;
      const model = getPrismaModel(table);
      const where = v.where ? buildWhere(v.where) : undefined;

      await model.updateMany({ where, data: v.set });
    },
    async create(table, values) {
      await init;
      if (relationMode === "prisma") {
        await Promise.all(
          table.foreignKeys.map((key) =>
            checkForeignKeyOnInsert(this, key, [values]),
          ),
        );
      }

      values = mapValues(table, values, true);
      const model = getPrismaModel(table);
      return mapResult(
        await model.create({
          data: values,
        }),
        table,
      );
    },
    async createMany(table, values) {
      await init;
      const idField = table.getIdColumn().names.prisma;
      if (relationMode === "prisma") {
        await Promise.all(
          table.foreignKeys.map((key) =>
            checkForeignKeyOnInsert(this, key, values),
          ),
        );
      }

      values = values.map((value) => mapValues(table, value, true));
      await getPrismaModel(table).createMany({ data: values });
      return values.map((value) => ({ _id: value[idField] }));
    },
    async deleteMany(table, v) {
      await init;
      const model = getPrismaModel(table);
      const where = v.where ? buildWhere(v.where) : undefined;

      await model.deleteMany({ where });
    },
    async upsert(table, { where, ...v }) {
      await init;

      await getPrismaModel(table).upsert({
        where: where ? buildWhere(where) : {},
        create: mapValues(table, v.create, true),
        update: mapValues(table, v.update),
      });
    },
    async transaction(run) {
      await init;

      return prisma.$transaction((tx) =>
        run(
          fromPrisma(schema, {
            ...config,
            isTransaction: true,
            prisma: tx,
          }),
        ),
      );
    },
  });
}
