import type { AnySchema, NameVariants } from "./create";

export function exportNameVariants(
  schema: AnySchema
): Record<string, NameVariants> {
  const out: Record<string, NameVariants> = {};

  for (const table of Object.values(schema.tables)) {
    out[table.ormName] = table.names;

    for (const col of Object.values(table.columns)) {
      out[`${table.ormName}.${col.ormName}`] = col.names;
    }
  }

  return out;
}
