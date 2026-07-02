import {
  type Expression,
  type FilterBuilder,
  type GenericTableInfo,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, type GenericId, v } from "convex/values";
import { type Condition, ConditionType } from "../query/condition-builder";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../schema";
import { deserializeSelect, deserializeWhere } from "./deserialize";
import { serializedSelect, serializedWhere } from "./serialize";

const mutationArgs = v.object({
  tableName: v.string(),
  secret: v.string(),
  action: v.union(
    v.object({
      type: v.literal("create"),
      data: v.array(v.record(v.string(), v.any())),
      returning: v.boolean(),
    }),
    v.object({
      type: v.literal("update"),
      where: v.optional(v.any()),
      set: v.record(v.string(), v.any()),
    }),
    v.object({
      type: v.literal("delete"),
      where: v.optional(v.any()),
    }),
    v.object({
      type: v.literal("upsert"),
      where: v.any(),
      create: v.record(v.string(), v.any()),
      update: v.record(v.string(), v.any()),
    })
  ),
});

const queryArgs = v.object({
  tableName: v.string(),
  secret: v.string(),
  query: v.union(
    v.object({
      type: v.literal("find"),
      where: v.optional(v.any()),
      select: v.any(),
      limit: v.optional(v.number()),
      offset: v.optional(v.number()),
    }),
    v.object({
      type: v.literal("count"),
      where: v.optional(v.any()),
    })
  ),
});

enum ValuesMode {
  Insert,
  Update,
}

function mapValues(
  mode: ValuesMode,
  values: Record<string, unknown>,
  table: AnyTable
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in table.columns) {
    if (mode === ValuesMode.Update && values[k] === undefined) continue;

    out[k] = values[k] ?? null;
  }
  return out;
}

class DeferredFilter {
  filter: (record: Record<string, unknown>) => boolean;

  constructor(filter: (record: Record<string, unknown>) => boolean) {
    this.filter = filter;
  }

  static onField(colName: string, filter: (v: unknown) => boolean) {
    return new DeferredFilter((record) => filter(record[colName]));
  }

  inverse() {
    const filter = this.filter;
    return new DeferredFilter((record) => !filter(record));
  }
}

type Filter = (builder: FilterBuilder<GenericTableInfo>) => Expression<boolean>;

function buildFilter(where: Condition, defer = false): Filter | DeferredFilter {
  function autoField(
    builder: FilterBuilder<GenericTableInfo>,
    v: AnyColumn | unknown
  ) {
    if (v instanceof Column) return builder.field(v.ormName);
    return v;
  }
  if (where.type === ConditionType.Compare) {
    const left = where.a;
    const right = where.b;
    const fieldName = left.ormName;

    let inverse = false;
    switch (where.operator) {
      case "=":
      case "is":
        if (defer) return DeferredFilter.onField(fieldName, (v) => v === right);

        return (b) => b.eq<any>(autoField(b, left), autoField(b, right));
      case "!=":
      case "is not":
        if (defer) return DeferredFilter.onField(fieldName, (v) => v !== right);

        return (b) => b.neq<any>(autoField(b, left), autoField(b, right));
      case "<":
        if (defer)
          return DeferredFilter.onField(
            fieldName,
            (v) =>
              typeof v === "number" && typeof right === "number" && v < right
          );
        return (b) => b.lt<any>(autoField(b, left), autoField(b, right));
      case "<=":
        if (defer)
          return DeferredFilter.onField(
            fieldName,
            (v) =>
              typeof v === "number" && typeof right === "number" && v <= right
          );
        return (b) => b.lte<any>(autoField(b, left), autoField(b, right));
      case ">":
        if (defer)
          return DeferredFilter.onField(
            fieldName,
            (v) =>
              typeof v === "number" && typeof right === "number" && v > right
          );
        return (b) => b.gt<any>(autoField(b, left), autoField(b, right));
      case ">=":
        if (defer)
          return DeferredFilter.onField(
            fieldName,
            (v) =>
              typeof v === "number" && typeof right === "number" && v >= right
          );
        return (b) => b.gte<any>(autoField(b, left), autoField(b, right));
      case "not in":
        inverse = true;
      case "in":
        if (!Array.isArray(right))
          throw new ConvexError(
            "FumaDB doesn't support using `in` operator against non-literal values"
          );

        if (defer)
          return DeferredFilter.onField(fieldName, (v) =>
            inverse ? !right.includes(v) : right.includes(v)
          );

        return (b) => {
          const leftField = autoField(b, left);
          const filter = b.or(...right.map((item) => b.eq(leftField, item)));

          return inverse ? b.not(filter) : filter;
        };

      case "not contains":
        inverse = true;
      case "contains":
        return DeferredFilter.onField(fieldName, (v) => {
          if (typeof v !== "string" || typeof right !== "string") return false;
          const result = v.includes(right);
          return inverse ? !result : result;
        });
      case "not ends with":
        inverse = true;
      case "ends with":
        return DeferredFilter.onField(fieldName, (v) => {
          if (typeof v !== "string" || typeof right !== "string") return false;
          const result = v.endsWith(right);
          return inverse ? !result : result;
        });
      case "not starts with":
        inverse = true;
      case "starts with":
        return DeferredFilter.onField(fieldName, (v) => {
          if (typeof v !== "string" || typeof right !== "string") return false;
          const result = v.startsWith(right);
          return inverse ? !result : result;
        });
    }
  }

  if (where.type === ConditionType.Not) {
    const filter = buildFilter(where.item, defer);
    if (filter instanceof DeferredFilter) return filter.inverse();
    return (b) => b.not(filter(b));
  }

  const filters: Filter[] = [];
  const deferredFilters: DeferredFilter[] = [];
  let deferItem = defer;

  for (const item of where.items) {
    const filter = buildFilter(item, deferItem);

    if (filter instanceof DeferredFilter) {
      if (!deferItem) {
        deferItem = true;

        // add previous items back
        for (const prev of where.items) {
          if (prev === item) break;
          deferredFilters.push(buildFilter(prev, true) as DeferredFilter);
        }
      }

      deferredFilters.push(filter);
    } else {
      filters.push(filter);
    }
  }

  if (deferItem)
    return where.type === ConditionType.And
      ? new DeferredFilter((record) => {
          for (const item of deferredFilters) {
            if (!item.filter(record)) return false;
          }

          return true;
        })
      : new DeferredFilter((record) => {
          for (const item of deferredFilters) {
            if (item.filter(record)) return true;
          }

          return false;
        });

  return (b) =>
    where.type === ConditionType.And
      ? b.and(...filters.map((f) => f(b)))
      : b.or(...filters.map((f) => f(b)));
}

export function createHandler(options: {
  schema: AnySchema;
  /**
   * A secret key to ensure this action is only accessible for your backend server.
   *
   * **Please be careful, anyone with the secret may access your database**.
   */
  secret: string;
}) {
  const { schema, secret } = options;
  if (!secret) throw new ConvexError("`secret` must be provided.");

  return {
    mutationHandler: mutationGeneric({
      args: mutationArgs,
      handler: async (ctx, { tableName, action, ...args }) => {
        if (args.secret !== secret) throw new ConvexError("Invalid secret");

        const table = schema.tables[tableName];
        if (!table) throw new ConvexError(`Unknown table: ${tableName}`);
        if (action.type === "create") {
          const ids = await Promise.all(
            action.data.map((values) => ctx.db.insert(tableName, values))
          );

          if (action.returning) {
            return await Promise.all(ids.map((id) => ctx.db.get(id)));
          }

          return;
        }

        if (action.type === "update") {
          const query = ctx.db.query(tableName);
          const filter = action.where
            ? buildFilter(deserializeWhere(action.where, { schema }))
            : undefined;
          let targets: Record<string, any>[];

          if (filter instanceof DeferredFilter) {
            targets = (await query.collect()).filter((v) => filter.filter(v));
          } else if (filter) {
            targets = await query.filter(filter).collect();
          } else {
            targets = await query.collect();
          }

          const mappedValues = mapValues(ValuesMode.Update, action.set, table);
          await Promise.all(
            targets.map((target) => ctx.db.patch(target._id, mappedValues))
          );
          return;
        }

        if (action.type === "upsert") {
          const query = ctx.db.query(tableName);
          const filter = buildFilter(
            deserializeWhere(action.where, { schema })
          );
          let target: Record<string, unknown>;
          if (filter instanceof DeferredFilter) {
            target = (await query.collect()).filter((v) => filter.filter(v))[0];
          } else {
            target = await query.filter(filter).first();
          }

          if (target) {
            await ctx.db.patch(
              target._id as GenericId<string>,
              mapValues(ValuesMode.Update, action.update, table)
            );
          } else {
            await ctx.db.insert(
              tableName,
              mapValues(ValuesMode.Insert, action.create, table)
            );
          }
          return;
        }

        if (action.type === "delete") {
          const query = ctx.db.query(tableName);
          const filter = action.where
            ? buildFilter(deserializeWhere(action.where, { schema }))
            : undefined;
          let targets: Record<string, unknown>[];

          if (filter instanceof DeferredFilter) {
            targets = (await query.collect()).filter((v) => filter.filter(v));
          } else if (filter) {
            targets = await query.filter(filter).collect();
          } else {
            targets = await query.collect();
          }

          await Promise.all(
            targets.map((target) =>
              ctx.db.delete(target._id as GenericId<string>)
            )
          );
          return;
        }

        throw new ConvexError("Unhandled action type");
      },
    }),
    queryHandler: queryGeneric({
      args: queryArgs,
      handler: async (ctx, { tableName, query: options, ...args }) => {
        if (args.secret !== secret) throw new ConvexError("Invalid secret");

        const table = schema.tables[tableName];
        if (!table) throw new ConvexError(`Unknown table: ${tableName}`);

        if (options.type === "find") {
          const { where, offset = 0, limit } = options;
          const _select = deserializeSelect(
            serializedSelect.parse(options.select)
          );

          const filter = where
            ? buildFilter(
                deserializeWhere(serializedWhere.parse(where), { schema })
              )
            : undefined;
          let query = ctx.db.query(tableName);
          let records: unknown[];

          if (filter instanceof DeferredFilter) {
            records = (await query.collect()).filter((v) => filter.filter(v));
            if (limit !== undefined) records = records.slice(offset, limit);
            else if (offset > 0) records = records.slice(offset);
          } else {
            if (filter) query = query.filter(filter);

            if (limit !== undefined) {
              records = await query.take(limit + offset);
            } else {
              records = await query.collect();
            }
            if (offset > 0) records = records.slice(offset);
          }

          return records;
        }

        const { where } = options;
        const filter = where
          ? buildFilter(
              deserializeWhere(serializedWhere.parse(where), { schema })
            )
          : undefined;
        let query = ctx.db.query(tableName);

        if (filter instanceof DeferredFilter) {
          let count = 0;
          for (const v of await query.collect()) {
            if (filter.filter(v)) count++;
          }
          return count;
        } else {
          if (filter) query = query.filter(filter);
          // TODO: consider aggregate, it currently needs some extra configure for user to enable it and with too much complexity
          return (await query.collect()).length;
        }
      },
    }),
  };
}
