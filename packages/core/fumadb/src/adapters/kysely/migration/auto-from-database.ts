import { generateMigrationFromSchema } from "../../../migration-engine/auto-from-schema";
import type { MigrationOperation } from "../../../migration-engine/shared";
import type { AnySchema } from "../../../schema/create";
import {
  applyNameVariants,
  type NameVariantsConfig,
} from "../../../schema/name-variants-builder";
import { dbToSchemaType } from "../../../schema/serialize";
import type { KyselyConfig } from "../../../shared/config";
import { introspectSchema } from "./introspect";

export async function generateMigration(
  schema: AnySchema,
  config: KyselyConfig,
  options: {
    nameVariants?: NameVariantsConfig;
    dropUnusedColumns?: boolean;
    internalTables: string[];
  }
): Promise<MigrationOperation[]> {
  const { db, provider } = config;
  const { dropUnusedColumns = true, internalTables, nameVariants } = options;
  const schemaWithVariant = nameVariants
    ? applyNameVariants(schema, nameVariants)
    : schema;

  const tables = Object.values(schemaWithVariant.tables);
  const tableNameMapping = new Map<string, string>();
  for (const t of tables) {
    tableNameMapping.set(t.names.sql, t.ormName);
  }

  const introspected = await introspectSchema({
    db,
    provider,
    columnNameMapping(tableName, columnName) {
      const name = tableNameMapping.get(tableName);
      if (!name) return columnName;

      const col = schemaWithVariant.tables[name].getColumnByName(columnName);
      if (!col) return columnName;

      return col.ormName;
    },
    columnTypeMapping(dataType, options) {
      const predicted = dbToSchemaType(dataType, provider, options.metadata);

      function fallback() {
        for (let item of predicted) {
          if (item === "varchar(n)") item = "varchar(255)";

          if (!options.isPrimaryKey) return item;

          if (item.startsWith("varchar")) return item;
        }

        throw new Error("failed to predict");
      }

      const col = schemaWithVariant.tables[
        tableNameMapping.get(options.tableMetadata.name) ??
          options.tableMetadata.name
      ]?.getColumnByName(options.metadata.name);

      if (!col) return fallback();

      for (const item of predicted) {
        if (item === col.type) return item;
        if (item === "varchar(n)" && col.type.startsWith("varchar"))
          return col.type;
      }

      return fallback();
    },
    tableNameMapping(tableName) {
      return tableNameMapping.get(tableName) ?? tableName;
    },
    internalTables,
  });

  return generateMigrationFromSchema(introspected.schema, schema, {
    ...config,
    dropUnusedColumns,
    dropUnusedTables: false,
  });
}
