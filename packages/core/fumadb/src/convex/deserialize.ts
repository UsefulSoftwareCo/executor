import type { AnySelectClause } from "../query";
import { type Condition, ConditionType } from "../query/condition-builder";
import type { AnyColumn, AnySchema } from "../schema/create";
import {
  type SerializedColumn,
  type SerializedSelect,
  type SerializedWhere,
  serializedColumn,
} from "./serialize";

interface Context {
  schema: AnySchema;
}

// Helper to resolve column from serialized form
function deserializeColumn(
  serialized: SerializedColumn,
  { schema }: Context,
): AnyColumn {
  const table = schema.tables[serialized.$table];
  if (!table) throw new Error(`Unknown table: ${serialized.$table}`);
  const column = table.columns[serialized.$column];
  if (!column) throw new Error(`Unknown Column: ${serialized.$column}`);

  return column;
}

export function deserializeSelect(select: SerializedSelect): AnySelectClause {
  return select;
}

export function deserializeWhere(
  where: SerializedWhere,
  context: Context,
): Condition {
  function run(where: SerializedWhere): Condition {
    if (where.type === "Compare") {
      const parsedB = serializedColumn.safeParse(where.b);

      return {
        type: ConditionType.Compare,
        a: deserializeColumn(where.a, context),
        operator: where.operator,
        b: parsedB.success ? deserializeColumn(parsedB.data, context) : where.b,
      };
    }
    if (where.type === "And" || where.type === "Or") {
      return {
        type: where.type === "And" ? ConditionType.And : ConditionType.Or,
        items: where.items.map(run),
      };
    }
    if (where.type === "Not") {
      return {
        type: ConditionType.Not,
        item: run(where.item),
      };
    }

    throw new Error("Unknown serialized condition type");
  }

  return run(where);
}
