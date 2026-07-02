import { type AnySchema, type AnyTable, IdColumn } from "../../schema/create";
import { schemaToDBType } from "../../schema/serialize";
import type { SQLProvider } from "../../shared/providers";
import { importGenerator } from "../../utils/import-generator";
import { ident, parseVarchar } from "../../utils/parse";

function toPascalCase(str: string): string {
  return str
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

export function generateSchema(
  schema: AnySchema,
  provider: SQLProvider
): string {
  const code: string[] = [];
  const imports = importGenerator();
  imports.addImport("Entity", "typeorm");

  function generateTable(table: AnyTable) {
    const lines: string[] = [];
    const className = toPascalCase(table.names.sql);

    // Add entity decorator
    lines.push(`@Entity("${table.names.sql}")`);
    lines.push(`export class ${className} {`);

    // Generate columns
    for (const [key, column] of Object.entries(table.columns)) {
      const options: string[] = [];
      let type: string;

      // Handle column type
      switch (column.type) {
        case "uuid":
          type = "string";
          options.push(`type: "uuid"`);
          break;
        case "integer":
          type = "number";
          break;
        case "bigint":
          type = "bigint";
          break;
        case "bool":
          type = "boolean";
          break;
        case "json":
          type = "object";
          break;
        case "timestamp":
        case "date":
          type = "Date";
          break;
        case "decimal":
          type = "number";
          break;
        case "binary":
          type = "Uint8Array";
          options.push(
            `type: "${schemaToDBType({ type: "binary" }, provider)}"`
          );
          break;
        default:
          type = "string";
          if (column.type.startsWith("varchar")) {
            const length = parseVarchar(column.type);

            if (length) {
              options.push(`length: ${length}`);
            }
          }
      }

      let decorator = "Column";
      // Add column decorator
      if (column instanceof IdColumn) {
        decorator =
          column.default &&
          "runtime" in column.default &&
          column.default.runtime === "auto"
            ? "PrimaryGeneratedColumn"
            : "PrimaryColumn";
      }

      if (key !== column.names.sql) {
        options.push(`name: "${column.names.sql}"`);
      }

      if (column.isNullable) {
        type += " | null";
        options.push(`nullable: true`);
      }

      if (column.isUnique) {
        options.push(`unique: true`);
      }

      if (column.default) {
        if ("value" in column.default) {
          options.push(`default: ${JSON.stringify(column.default.value)}`);
        } else if (column.default.runtime === "now") {
          options.push("default: () => 'CURRENT_TIMESTAMP'");
        }
      }

      let arg = "";
      if (options.length > 0) {
        arg = `{\n${ident(options.join(",\n"))}\n}`;
      }

      imports.addImport(decorator, "typeorm");
      lines.push(ident(`@${decorator}(${arg})`));
      lines.push(`  ${key}: ${type};`);
      lines.push("");
    }

    for (const k in table.relations) {
      const relation = table.relations[k];
      if (!relation) continue;

      function buildJoinColumn() {
        imports.addImport("JoinColumn", "typeorm");
        const args: string[] = [];

        for (const [left, right] of relation.on) {
          args.push(`{ name: "${left}", referencedColumnName: "${right}" }`);
        }

        return `  @JoinColumn([${args.join(", ")}])`;
      }
      let decorator: string;
      const className = toPascalCase(relation.table.ormName);
      const args: string[] = [`() => ${className}`];
      let type = className;

      if (relation.implied) {
        if (relation.type === "many") {
          decorator = "OneToMany";
          type += "[]";
        } else decorator = "OneToOne";

        args.push(`v => v.${relation.impliedBy?.name}`);
      } else {
        if (relation.implying?.type === "many") decorator = "ManyToOne";
        else decorator = "OneToOne";

        args.push(`v => v.${relation.implying?.name}`);
        lines.push(buildJoinColumn());
        const config = relation.foreignKey;

        if (config) {
          args.push(
            `{ onUpdate: "${config.onUpdate}", onDelete: "${config.onDelete}" }`
          );
        }
      }

      imports.addImport(decorator, "typeorm");
      lines.push(`  @${decorator}(${args.join(", ")})`);
      lines.push(`  ${relation.name}: ${type}`);
      lines.push("");
    }

    lines.pop();
    lines.push("}");
    return lines.join("\n");
  }

  // Generate all tables
  for (const table of Object.values(schema.tables)) {
    code.push(generateTable(table));
  }

  code.unshift(imports.format());
  return code.join("\n\n");
}
