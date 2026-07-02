import {
  Binary,
  type ClientSession,
  type Document,
  type Filter,
  type MongoClient,
  ObjectId,
} from "mongodb";
import type {
  AbstractQuery,
  AnySelectClause,
  FindManyOptions,
} from "../../query";
import {
  type Condition,
  ConditionType,
  type Operator,
} from "../../query/condition-builder";
import { type SimplifyFindOptions, toORM } from "../../query/orm";
import { createSoftForeignKey } from "../../query/polyfills/foreign-key";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../../schema";

function buildWhere(condition: Condition): Filter<Document> {
  function doc(name: string, op: Operator, value: unknown): Filter<Document> {
    switch (op) {
      case "=":
      case "is":
        if (value == null) return { [name]: { $exists: false } };

        return { [name]: value };
      case "!=":
      case "is not":
        if (value == null) return { [name]: { $exists: true } };

        return { [name]: { $ne: value } };
      case ">":
        return { [name]: { $gt: value } };
      case ">=":
        return { [name]: { $gte: value } };
      case "<":
        return { [name]: { $lt: value } };
      case "<=":
        return { [name]: { $lte: value } };
      case "in":
        return { [name]: { $in: value } };
      case "not in":
        return { [name]: { $nin: value } };
      case "starts with":
        return { [name]: { $regex: `^${value}`, $options: "i" } };
      case "not starts with":
        return { [name]: { $not: { $regex: `^${value}`, $options: "i" } } };
      case "contains":
        return { [name]: { $regex: value, $options: "i" } };
      case "not contains":
        return { [name]: { $not: { $regex: value, $options: "i" } } };
      case "ends with":
        return { [name]: { $regex: `${value}$`, $options: "i" } };
      case "not ends with":
        return { [name]: { $not: { $regex: `${value}$`, $options: "i" } } };
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  function expr(exp1: string, op: Operator, exp2: string): Filter<Document> {
    switch (op) {
      case "=":
      case "is":
        return { $eq: [exp1, exp2] };
      case "!=":
      case "is not":
        return { $ne: [exp1, exp2] };
      case ">":
        return { $gt: [exp1, exp2] };
      case ">=":
        return { $gte: [exp1, exp2] };
      case "<":
        return { $lt: [exp1, exp2] };
      case "<=":
        return { $lte: [exp1, exp2] };
      case "in":
        return { $in: [exp1, exp2] };
      case "not in":
        return { $nin: [exp1, exp2] };
      case "starts with":
        return {
          $regexMatch: {
            input: exp1,
            regex: `^${exp2}`,
            options: "i",
          },
        };
      case "not starts with":
        return {
          $not: [expr(exp1, "starts with", exp2)],
        };
      case "contains":
        return {
          $regexMatch: {
            input: exp1,
            regex: exp2,
            options: "i",
          },
        };
      case "not contains":
        return {
          $not: [expr(exp1, "contains", exp2)],
        };
      case "ends with":
        return {
          $regexMatch: {
            input: exp1,
            regex: `${exp2}$`,
            options: "i",
          },
        };
      case "not ends with":
        return {
          $not: [expr(exp1, "ends with", exp2)],
        };
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  if (condition.type === ConditionType.Compare) {
    const column = condition.a;
    const value = condition.b;

    const name = column.names.mongodb;
    if (value instanceof Column) {
      return {
        $match: expr(
          `$${name}`,
          condition.operator,
          column.table === value.table
            ? `$${value.names.mongodb}`
            : `$$${value.table?.ormName}_${value.ormName}`
        ),
      };
    }

    return doc(name, condition.operator, serialize(value));
  }

  if (condition.type === ConditionType.And) {
    return {
      $and: condition.items.map(buildWhere),
    };
  }

  if (condition.type === ConditionType.Not) {
    return {
      $not: buildWhere(condition),
    };
  }

  return {
    $or: condition.items.map(buildWhere),
  };
}

function mapProjection(select: AnySelectClause, table: AnyTable): Document {
  const out: Document = {
    _id: 0,
  };

  function item(col: AnyColumn) {
    out[col.ormName] = { $ifNull: [`$${col.names.mongodb}`, null] };
  }

  if (select === true) {
    for (const col of Object.values(table.columns)) item(col);
  } else {
    for (const k of select) {
      const col = table.columns[k];
      if (!col) continue;

      item(col);
    }
  }

  return out;
}

function mapSort(orderBy: [column: AnyColumn, "asc" | "desc"][]) {
  const out: Record<string, 1 | -1> = {};

  for (const [col, mode] of orderBy) {
    out[col.names.mongodb] = mode === "asc" ? 1 : -1;
  }

  return out;
}

function serialize(value: unknown) {
  if (value instanceof Uint8Array) {
    value = new Binary(value);
  }

  return value;
}

function mapInsertValues(values: Record<string, unknown>, table: AnyTable) {
  const out: Record<string, unknown> = {};

  for (const k in table.columns) {
    const col = table.columns[k];
    const value = serialize(values[k]);

    if (value != null) out[col.names.mongodb] = value;
  }

  return out;
}

function mapResult(
  result: Record<string, unknown>,
  table: AnyTable
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const k in result) {
    let value = result[k];

    if (k in table.relations) {
      const relation = table.relations[k];

      if (Array.isArray(value)) {
        value = value.map((v) => mapResult(v, relation.table));
      } else if (value) {
        value = mapResult(value as any, relation.table);
      }

      out[k] = value;
      continue;
    }

    if (value instanceof ObjectId) {
      value = value.toString("hex");
    } else if (value instanceof Binary) {
      const buffer = value.buffer;
      value =
        buffer instanceof Buffer
          ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          : buffer;
    }

    out[k] = value;
  }

  return out;
}

/**
 * This adapter uses string ids instead of object id, which is better suited for the API design of FumaDB.
 */
export function fromMongoDB(
  schema: AnySchema,
  client: MongoClient,
  session?: ClientSession
): AbstractQuery<AnySchema> {
  const db = client.db();

  function buildFindPipeline(
    table: AnyTable,
    v: SimplifyFindOptions<FindManyOptions>
  ) {
    const pipeline: Document[] = [];
    const where = v.where ? buildWhere(v.where) : undefined;

    if (where) pipeline.push({ $match: where });
    if (v.limit !== undefined)
      pipeline.push({
        $limit: v.limit,
      });
    if (v.offset !== undefined)
      pipeline.push({
        $skip: v.offset,
      });
    if (v.orderBy) {
      pipeline.push({ $sort: mapSort(v.orderBy) });
    }
    const project = mapProjection(v.select, table);

    if (v.join) {
      for (const { relation, options: joinOptions } of v.join) {
        project[relation.name] = 1;

        if (joinOptions === false) continue;
        const vars: Record<string, string> = {};

        for (const column of Object.values(table.columns)) {
          vars[`${table.ormName}_${column.ormName}`] =
            `$${column.names.mongodb}`;
        }

        const targetTable = relation.table;
        pipeline.push({
          $lookup: {
            from: targetTable.names.mongodb,
            let: vars,
            pipeline: [
              ...relation.on.map(([left, right]) => {
                return {
                  $match: {
                    $expr: {
                      $eq: [
                        `$${targetTable.columns[right].names.mongodb}`,
                        `$$${table.ormName}_${left}`,
                      ],
                    },
                  },
                };
              }),
              ...buildFindPipeline(targetTable, {
                ...joinOptions,
                limit: relation.type === "many" ? joinOptions.limit : 1,
              }),
            ],
            as: relation.name,
          },
        });

        if (relation.type === "one") {
          pipeline.push({
            $set: {
              [relation.name]: {
                $ifNull: [{ $first: `$${relation.name}` }, null],
              },
            },
          });
        }
      }
    }

    pipeline.push({
      $project: project,
    });

    return pipeline;
  }

  const orm = createSoftForeignKey(schema, {
    generateInsertValuesDefault(table, values) {
      const out: Record<string, unknown> = {};

      for (const k in table.columns) {
        if (values[k] === undefined) {
          out[k] = table.columns[k].generateDefaultValue();
        } else {
          out[k] = values[k];
        }
      }

      return out;
    },
    tables: schema.tables,
    async count(table, { where }) {
      return await db
        .collection(table.names.mongodb)
        .countDocuments(where ? buildWhere(where) : undefined, { session });
    },
    async findFirst(table, v) {
      const result = await orm.findMany(table, {
        ...v,
        limit: 1,
      });

      return result[0] ?? null;
    },
    async findMany(table, v) {
      const query = db
        .collection(table.names.mongodb)
        .aggregate(buildFindPipeline(table, v), { session });

      const result = await query.toArray();
      return result.map((v) => mapResult(v, table));
    },
    async updateMany(table, v) {
      const where = v.where ? buildWhere(v.where) : {};
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};

      for (const k in v.set) {
        const col = table.columns[k];
        const value = v.set[k];
        if (!col || value === undefined) continue;

        const name = col.names.mongodb;

        if (value === null) {
          unset[name] = "";
        } else {
          set[name] = serialize(value);
        }
      }

      await db.collection(table.names.mongodb).updateMany(
        where,
        {
          $set: set,
          $unset: unset,
        },
        {
          session,
        }
      );
    },
    async create(table, values) {
      const collection = db.collection(table.names.mongodb);
      const { insertedId } = await collection.insertOne(
        mapInsertValues(values, table),
        { session }
      );

      const result = await collection.findOne(
        {
          _id: insertedId,
        },
        {
          session,
          projection: mapProjection(true, table),
        }
      );

      if (result === null)
        throw new Error(
          "Failed to insert document: cannot find inserted coument."
        );
      return mapResult(result, table);
    },
    async createMany(table, values) {
      const idField = table.getIdColumn().names.mongodb;
      values = values.map((v) => mapInsertValues(v, table));

      await db.collection(table.names.mongodb).insertMany(values, { session });
      return values.map((value) => ({ _id: value[idField] }));
    },
    async deleteMany(table, v) {
      const where = v.where ? buildWhere(v.where) : undefined;

      await db.collection(table.names.mongodb).deleteMany(where, { session });
    },
    async transaction(run) {
      const child = client.startSession();

      try {
        return await child.withTransaction(
          () => run(fromMongoDB(schema, client, child)),
          {
            session,
          }
        );
      } finally {
        await child.endSession();
      }
    },
  });

  return toORM(orm);
}
