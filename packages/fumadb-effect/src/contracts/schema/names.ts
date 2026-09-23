/**
 * Name variants.
 *
 * Every table and column has an ORM name (the key in the schema definition,
 * used in queries) and a SQL name (the identifier in the database). Consumers
 * can override SQL names to avoid clashes with their own tables. The migrator
 * stores the variants that were applied so a later change can be migrated.
 */
import { Schema } from "effect";
import type { AnySchema } from "./schema.ts";

/** Database-facing names for one table or column. */
export interface NameVariants {
  readonly sql: string;
}

/**
 * Overrides keyed by `table` or `table.column` ORM names.
 *
 * ```ts
 * { messages: { sql: "chat_messages" }, "messages.id": { sql: "message_id" } }
 * ```
 */
export const NameVariantsConfig = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.Struct({ sql: Schema.optionalKey(Schema.String) })),
);
/** Parsed table and column name overrides. */
export type NameVariantsConfig = typeof NameVariantsConfig.Type;

/** All name variants of a schema, keyed like `NameVariantsConfig`. */
export const exportNameVariants = (schema: AnySchema): Record<string, NameVariants> => {
  const out: Record<string, NameVariants> = {};
  for (const table of Object.values(schema.tables)) {
    out[table.ormName] = table.names;
    for (const column of Object.values(table.columns)) {
      out[`${table.ormName}.${column.ormName}`] = column.names;
    }
  }
  return out;
};

/**
 * Apply name overrides to a schema.
 *
 * Returns a new schema; the input is not modified. Unknown tables and columns
 * are ignored so stored variants from an older version do not break a newer one.
 */
export const applyNameVariants = <S extends AnySchema>(schema: S, names: NameVariantsConfig): S => {
  const cloned = schema.clone() as AnySchema;
  for (const [key, override] of Object.entries(names)) {
    if (override === undefined) continue;
    const dot = key.indexOf(".");
    const tableName = dot === -1 ? key : key.slice(0, dot);
    const columnName = dot === -1 ? undefined : key.slice(dot + 1);
    const table = cloned.tables[tableName];
    if (table === undefined) continue;
    if (columnName === undefined) {
      table.names = { ...table.names, ...override };
      continue;
    }
    const column = table.columns[columnName];
    if (column === undefined) continue;
    column.names = { ...column.names, ...override };
  }
  // SAFETY: `clone()` returns the same schema type; only names changed.
  return cloned as unknown as S;
};

/** Prefix every table's SQL name. Returns a new schema. */
export const applyNameVariantsPrefix = <S extends AnySchema>(schema: S, prefix: string): S => {
  const generated: Record<string, Partial<NameVariants>> = {};
  for (const [tableName, table] of Object.entries(schema.tables)) {
    generated[tableName] = { sql: prefix + table.names.sql };
  }
  return applyNameVariants(schema, generated);
};
