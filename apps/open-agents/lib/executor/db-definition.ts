import { collectTables } from "@executor-js/api/server";
import type { AnyTable } from "@executor-js/fumadb/schema";

export const OPEN_AGENTS_EXECUTOR_NAMESPACE = "open_agents_executor";
export const OPEN_AGENTS_EXECUTOR_SCHEMA_VERSION = "1.0.0";
export const OPEN_AGENTS_EXECUTOR_DB_PROVIDER = "postgresql";

function prefixTableNames(name: string, table: AnyTable): AnyTable {
  const prefixedTable = table.clone();
  const { names } = prefixedTable;
  const prefix = `${OPEN_AGENTS_EXECUTOR_NAMESPACE}_`;
  const storageName = `${prefix}${names.sql}`;

  prefixedTable.names = {
    convex: name,
    drizzle: name,
    mongodb: storageName,
    prisma: name,
    sql: storageName,
  };

  for (const constraint of prefixedTable.getUniqueConstraints()) {
    constraint.name = `${prefix}${constraint.name}`;
  }
  for (const foreignKey of prefixedTable.foreignKeys) {
    foreignKey.name = `${prefix}${foreignKey.name}`;
  }

  return prefixedTable;
}

const prefixedExecutorTables: Record<string, AnyTable> = {};
for (const [name, table] of Object.entries(collectTables())) {
  prefixedExecutorTables[name] = prefixTableNames(name, table);
}

export const openAgentsExecutorTables = prefixedExecutorTables;
