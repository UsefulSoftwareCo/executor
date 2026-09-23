/**
 * The SQL adapter: FumaDB over Effect SQL's `SqlClient`.
 *
 * ```ts
 * const client = ChatDB.client(sqlAdapter({ provider: "postgresql" }))
 * // provide PgClient.layer(...) (or any SqlClient layer) to run its effects
 * ```
 */
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Adapter } from "../../contracts/adapter.ts";
import { defaultRelationMode } from "../../contracts/provider.ts";
import { toOrm } from "../query/orm.ts";
import { createSoftForeignKey } from "../query/soft-foreign-key.ts";
import type { ResolvedSqlAdapterConfig, SqlAdapterConfig } from "../../contracts/sql.ts";
import { createSqlMigrator } from "./migrator.ts";
import { makeSqlOrmAdapter } from "./query.ts";
import { getSettingsVersion, settingsTableName } from "./settings.ts";

export type { SqlAdapterConfig } from "../../contracts/sql.ts";
/** Render migration operations as SQL text for one provider. */
export { renderScript, renderStatements } from "./ddl.ts";
export {
  generateMigrationFromDatabase,
  introspectSchema,
  type IntrospectOptions,
} from "./introspect.ts";
/** The SQL name of the private settings table for a library namespace. */
export { settingsTableName } from "./settings.ts";
/** The transformer that rewrites unsupported SQLite operations into table recreates. */
export { sqliteTransformer } from "./sqlite-transformer.ts";

const resolveConfig = (config: SqlAdapterConfig): ResolvedSqlAdapterConfig => ({
  provider: config.provider,
  relationMode: config.relationMode ?? defaultRelationMode(config.provider),
});

/** Create the SQL adapter. Its operations need `SqlClient.SqlClient` in the environment. */
export const sqlAdapter = (config: SqlAdapterConfig): Adapter<SqlClient> => {
  const resolved = resolveConfig(config);
  return {
    name: "sql",
    createOrm: (_context, schema) => {
      const base = makeSqlOrmAdapter(schema, resolved);
      const adapter =
        resolved.relationMode === "fumadb" ? createSoftForeignKey(schema, base) : base;
      return toOrm(schema, adapter);
    },
    getSchemaVersion: (context) =>
      getSettingsVersion(resolved.provider, settingsTableName(context.namespace)),
    createMigrator: (context) => createSqlMigrator(context, resolved),
  };
};
