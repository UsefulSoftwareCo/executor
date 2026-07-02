import z from "zod";
import type { AnySelectClause } from "../query";
import {
  type Condition,
  ConditionType,
  operators,
} from "../query/condition-builder";
import { type AnyColumn, type AnyTable, Column } from "../schema/create";

export const serializedSelect = z.array(z.string());

export const serializedColumn = z.looseObject({
  $table: z.string(),
  $column: z.string(),
});

export const serializedWhere = z.union([
  z.object({
    type: z.literal("Compare"),
    a: serializedColumn,
    operator: z.literal(operators),
    b: z.union([serializedColumn, z.unknown()]),
  }),
  z.object({
    type: z.literal(["And", "Or"]),
    get items() {
      return z.array(serializedWhere);
    },
  }),
  z.object({
    type: z.literal("Not"),
    get item() {
      return serializedWhere;
    },
  }),
]);

/**
 * column names
 */
export type SerializedSelect = z.infer<typeof serializedSelect>;

/**
 * Serialized Condition
 */
export type SerializedWhere = z.infer<typeof serializedWhere>;

export type SerializedColumn = z.infer<typeof serializedColumn>;

function serializeColumn(col: AnyColumn) {
  return {
    $table: col.table!.ormName,
    $column: col.ormName,
  };
}

export function serializeSelect(
  table: AnyTable,
  select: AnySelectClause
): SerializedSelect {
  if (select === true) return Object.keys(table.columns);
  return select;
}

export function serializeWhere(where: Condition): SerializedWhere {
  if (where.type === ConditionType.Compare) {
    return {
      type: "Compare",
      a: serializeColumn(where.a),
      operator: where.operator,
      b: where.b instanceof Column ? serializeColumn(where.b) : where.b,
    };
  }
  if (where.type === ConditionType.And || where.type === ConditionType.Or) {
    return {
      type: where.type === ConditionType.And ? "And" : "Or",
      items: where.items.map(serializeWhere),
    };
  }
  if (where.type === ConditionType.Not) {
    return {
      type: "Not",
      item: serializeWhere(where.item),
    };
  }
  throw new Error("Unknown condition type");
}
