import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  IdColumn,
} from "../../schema/create";
import { schemaToDBType } from "../../schema/serialize";
import type { SQLProvider } from "../../shared/providers";
import { importGenerator } from "../../utils/import-generator";
import { ident, parseVarchar } from "../../utils/parse";

export function generateSchema(
  schema: AnySchema,
  provider: Exclude<SQLProvider, "cockroachdb" | "mssql">,
): string {
  const imports = importGenerator();
  const importSource = {
    mysql: "drizzle-orm/mysql-core",
    postgresql: "drizzle-orm/pg-core",
    sqlite: "drizzle-orm/sqlite-core",
  }[provider];

  const tableFn = {
    mysql: "mysqlTable",
    postgresql: "pgTable",
    sqlite: "sqliteTable",
  }[provider];

  const generatedCustomTypes = new Set<string>();
  function generateCustomType(
    name: string,
    options: {
      dataType: string;
      driverDataType: string;
      databaseDataType: string;

      fromDriverCode: string;
      toDriverCode: string;
    },
  ) {
    if (generatedCustomTypes.has(name)) return;

    imports.addImport("customType", importSource);
    generatedCustomTypes.add(name);
    return `const ${name} = customType<
  {
    data: ${options.dataType};
    driverData: ${options.driverDataType};
  }
>({
  dataType() {
    return "${options.databaseDataType}";
  },
  fromDriver(value) {
    ${options.fromDriverCode}
  },
  toDriver(value) {
    ${options.toDriverCode}
  }
});`;
  }

  function generateBinary() {
    const name = "customBinary";
    // most Node.js based drivers return Buffer for binary data, make sure to convert them
    const code = generateCustomType(name, {
      dataType: "Uint8Array",
      driverDataType: "Buffer",
      databaseDataType: schemaToDBType({ type: "binary" }, provider),
      fromDriverCode:
        "return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)",
      toDriverCode: `return value instanceof Buffer? value : Buffer.from(value)`,
    });

    if (code) lines.push(code);
    return name;
  }

  function getColumnTypeFunction(column: AnyColumn): {
    name: string;
    isCustomType?: boolean;
    params?: string[];
  } {
    if (provider === "sqlite") {
      switch (column.type) {
        case "uuid":
          return { name: "text" };
        case "bigint":
          return {
            name: "blob",
            params: [`{ mode: "bigint" }`],
          };
        case "bool":
          return {
            name: "integer",
            params: [`{ mode: "boolean" }`],
          };
        case "json":
          return { name: "blob", params: [`{ mode: "json" }`] };
        // for sqlite, generate dates as a timestamp
        case "timestamp":
        case "date":
          return { name: "integer", params: [`{ mode: "timestamp" }`] };
        case "decimal":
          return { name: "real" };
      }
    }

    switch (column.type) {
      case "uuid":
        if (provider === "postgresql") {
          return { name: "uuid" };
        } else if (provider === "mysql") {
          return {
            name: "char",
            params: [`{ length: 36 }`],
          };
        }
        return { name: "text" };
      case "string":
        return { name: "text" };
      case "binary":
        return {
          name: generateBinary(),
          isCustomType: true,
        };
      case "bool":
        return { name: "boolean" };
      case "bigint":
        return { name: "bigint", params: [`{ mode: "bigint" }`] };
      default:
        if (column.type.startsWith("varchar")) {
          return {
            name: provider === "sqlite" ? "text" : "varchar",
            params: [`{ length: ${parseVarchar(column.type)} }`],
          };
        }

        return { name: column.type };
    }
  }

  function generateTable(table: AnyTable) {
    const cols: string[] = [];

    for (const column of Object.values(table.columns)) {
      const col: string[] = [];
      const typeFn = getColumnTypeFunction(column);
      // Handle column type
      const params: string[] = [
        `"${column.names.sql}"`,
        ...(typeFn.params ?? []),
      ];

      if (!typeFn.isCustomType) imports.addImport(typeFn.name, importSource);
      col.push(`${typeFn.name}(${params.join(", ")})`);

      if (column instanceof IdColumn || (column as { id?: unknown }).id === true) {
        col.push("primaryKey()");
      }

      if (column.isUnique) {
        col.push("unique()");
      }

      if (!column.isNullable) {
        col.push("notNull()");
      }

      // Handle default values
      if (column.default) {
        if ("value" in column.default) {
          const value = JSON.stringify(column.default.value);
          col.push(`default(${value})`);
        } else if (column.default.runtime === "auto") {
          imports.addImport("createId", "@executor-js/fumadb/cuid");
          col.push("$defaultFn(() => createId())");
        } else if (column.default.runtime === "now") {
          col.push("defaultNow()");
        }
      }

      cols.push(`  ${column.names.drizzle}: ${col.join(".")}`);
    }

    const args: string[] = [`"${table.names.sql}"`];
    args.push(`{\n${cols.join(",\n")}\n}`);

    const keys: string[] = [];
    for (const key of table.foreignKeys) {
      const referencedTable = key.referencedTable;

      const columns = key.columns.map((col) => `table.${col.names.drizzle}`);
      const foreignColumns = key.referencedColumns.map(
        (col) => `${referencedTable.names.drizzle}.${col.names.drizzle}`,
      );

      imports.addImport("foreignKey", importSource);
      let code = `foreignKey({
  columns: [${columns.join(", ")}],
  foreignColumns: [${foreignColumns.join(", ")}],
  name: "${key.name}"
})`;
      if (key?.onUpdate) code += `.onUpdate("${key.onUpdate.toLowerCase()}")`;

      if (key?.onDelete) code += `.onDelete("${key.onDelete.toLowerCase()}")`;

      keys.push(code);
    }

    for (const con of table.getUniqueConstraints("table")) {
      imports.addImport("uniqueIndex", importSource);
      keys.push(
        `uniqueIndex("${con.name}").on(${con.columns.map((col) => `table.${col.names.drizzle}`).join(", ")})`,
      );
    }

    if (keys.length > 0)
      args.push(`(table) => [\n${ident(keys.join(",\n"))}\n]`);

    return `export const ${table.names.drizzle} = ${tableFn}(${args.join(", ")})`;
  }

  function generateRelation(table: AnyTable) {
    const cols: string[] = [];

    for (const relation of Object.values(table.relations)) {
      const options: string[] = [`relationName: "${relation.id}"`];

      // only `many` doesn't require fields, references
      if (!relation.implied || relation.type === "one") {
        const fields: string[] = [];
        const references: string[] = [];

        for (const [left, right] of relation.on) {
          fields.push(
            `${table.names.drizzle}.${table.columns[left].names.drizzle}`,
          );
          references.push(
            `${relation.table.names.drizzle}.${relation.table.columns[right].names.drizzle}`,
          );
        }

        options.push(
          `fields: [${fields.join(", ")}]`,
          `references: [${references.join(", ")}]`,
        );
      }

      const args: string[] = [];
      args.push(relation.table.names.drizzle);
      if (options.length > 0) args.push(`{\n${ident(options.join(",\n"))}\n}`);

      cols.push(
        ident(`${relation.name}: ${relation.type}(${args.join(", ")})`),
      );
    }

    if (cols.length === 0) return;
    imports.addImport("relations", "drizzle-orm");
    return `export const ${table.names.drizzle}Relations = relations(${
      table.names.drizzle
    }, ({ one, many }) => ({
${cols.join(",\n")}
}));`;
  }

  imports.addImport(tableFn, importSource);
  const lines: string[] = [];
  for (const table of Object.values(schema.tables)) {
    lines.push(generateTable(table));
    const relation = generateRelation(table);
    if (relation) lines.push(relation);
  }

  lines.unshift(imports.format());
  return lines.join("\n\n");
}
