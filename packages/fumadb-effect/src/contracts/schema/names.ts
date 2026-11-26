import { Schema } from "effect";
import type { AnySchema } from "./schema.ts";

export interface NameVariants {
  readonly sql: string;
}

export const NameVariantsConfig = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.Struct({ sql: Schema.optionalKey(Schema.String) })),
);
export type NameVariantsConfig = typeof NameVariantsConfig.Type;

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
  return cloned as unknown as S;
};

export const applyNameVariantsPrefix = <S extends AnySchema>(schema: S, prefix: string): S => {
  const generated: Record<string, Partial<NameVariants>> = {};
  for (const [tableName, table] of Object.entries(schema.tables)) {
    generated[tableName] = { sql: prefix + table.names.sql };
  }
  return applyNameVariants(schema, generated);
};
