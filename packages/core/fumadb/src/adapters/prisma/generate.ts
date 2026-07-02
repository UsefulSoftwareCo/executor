import {
  type AnySchema,
  type AnyTable,
  type ForeignKeyAction,
  IdColumn,
} from "../../schema/create";
import type { Provider } from "../../shared/providers";
import { parseVarchar } from "../../utils/parse";

const foreignKeyActionMap: Record<ForeignKeyAction, string> = {
  "SET NULL": "SetNull",
  CASCADE: "Cascade",
  RESTRICT: "Restrict",
};

export function generateSchema(schema: AnySchema, provider: Provider): string {
  function generateTable(table: AnyTable) {
    const code: string[] = [`model ${table.names.prisma} {`];

    for (const column of Object.values(table.columns)) {
      let type: string;
      const attributes: string[] = [];

      function map(name: string) {
        if (column.names.prisma === name) return;
        attributes.push(`@map("${name}")`);
      }

      map(provider === "mongodb" ? column.names.mongodb : column.names.sql);

      switch (column.type) {
        case "uuid":
          type = "String";
          switch (provider) {
            case "postgresql":
            case "cockroachdb":
              attributes.push("@db.Uuid");
              break;
            case "mssql":
              attributes.push("@db.UniqueIdentifier");
              break;
            // MySQL, SQLite, MongoDB use String without db attribute
          }
          break;
        case "integer":
          type = "Int";
          break;
        case "bigint":
          type = "BigInt";
          break;
        case "bool":
          type = "Boolean";
          break;
        case "json":
          type = "Json";
          break;
        case "timestamp":
        case "date":
          type = "DateTime";
          break;
        case "decimal":
          type = "Decimal";
          break;
        case "binary":
          type = "Bytes";
          break;
        default:
          type = "String";

          if (column.type.startsWith("varchar")) {
            const parsed = parseVarchar(column.type);

            switch (provider) {
              case "cockroachdb":
                attributes.push(`@db.String(${parsed})`);
                break;
              case "mysql":
              case "postgresql":
              case "mssql":
                attributes.push(`@db.VarChar(${parsed})`);
                break;
            }
          }
      }

      if (column instanceof IdColumn) {
        attributes.push("@id");
      }

      if (column.isUnique) {
        attributes.push("@unique");
      }

      if (column.default) {
        if ("value" in column.default) {
          attributes.push(`@default(${JSON.stringify(column.default.value)})`);
        } else if (column.default.runtime === "auto") {
          attributes.push("@default(cuid())");
        } else if (column.default.runtime === "now") {
          attributes.push("@default(now())");
        }
      }

      // Add nullable modifier if needed
      if (column.isNullable) {
        type += "?";
      }

      code.push(`  ${[column.names.prisma, type, ...attributes].join(" ")}`);
    }

    for (const relation of Object.values(table.relations)) {
      let type = relation.table.names.prisma;

      if (relation.implied) {
        if (relation.type === "many") type += "[]";
        else type += "?";

        code.push(`  ${relation.name} ${type} @relation("${relation.id}")`);
        continue;
      }

      const fields: string[] = [];
      const references: string[] = [];
      let isOptional = false;

      for (const [left, right] of relation.on) {
        const col = table.columns[left];
        const refCol = relation.table.columns[right];

        if (col.isNullable) isOptional = true;
        fields.push(col.names.prisma);
        references.push(refCol.names.prisma);
      }

      if (isOptional) type += "?";
      const config = relation.foreignKey!;
      code.push(
        `  ${relation.name} ${type} @relation(${[
          `"${relation.id}"`,
          `fields: [${fields.join(", ")}]`,
          `references: [${references.join(", ")}]`,
          `onUpdate: ${foreignKeyActionMap[config.onUpdate]}`,
          `onDelete: ${foreignKeyActionMap[config.onDelete]}`,
        ].join(", ")})`
      );
    }

    for (const con of table.getUniqueConstraints("table")) {
      code.push(
        `@@unique([${con.columns.map((col) => col.names.prisma).join(", ")}])`
      );
    }

    function mapTable(name: string) {
      if (table.names.prisma === name) return;
      code.push(`@@map("${name}")`);
    }

    mapTable(provider === "mongodb" ? table.names.mongodb : table.names.sql);

    code.push("}");
    return code.join("\n");
  }

  const lines: string[] = [];
  for (const t of Object.values(schema.tables)) {
    lines.push(generateTable(t));
  }

  return lines.join("\n\n");
}
