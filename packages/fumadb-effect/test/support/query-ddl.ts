/**
 * Hand-written DDL for the query tests.
 *
 * The query adapter is tested on its own, so the tables are created here from
 * the schema instead of through the migrator. The types mirror
 * `src/schema/codec.ts` `schemaToDbType`, and the real foreign keys and unique
 * constraints of the schema are created, because the query tests rely on them.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Provider } from "../../src/contracts/provider.ts";
import { schemaToDbType } from "../../src/implementation/schema-codec.ts";
import { isIdColumn } from "../../src/contracts/schema/column.ts";
import type { ForeignKeyAction } from "../../src/contracts/schema/relation.ts";
import type { AnySchema } from "../../src/contracts/schema/schema.ts";
import type { AnyTable } from "../../src/contracts/schema/table.ts";

const quote = (provider: Provider, name: string): string => {
  if (provider === "mysql") return `\`${name.replaceAll("`", "``")}\``;
  if (provider === "mssql") return `[${name.replaceAll("]", "]]")}]`;
  return `"${name.replaceAll(`"`, `""`)}"`;
};

/** MSSQL spells `RESTRICT` as `NO ACTION`. */
const action = (provider: Provider, value: ForeignKeyAction): string =>
  provider === "mssql" && value === "RESTRICT" ? "NO ACTION" : value;

/** Tables in an order where a table's foreign key targets already exist. */
const sortTables = (schema: AnySchema): ReadonlyArray<AnyTable> => {
  const remaining = Object.values(schema.tables);
  const sorted: Array<AnyTable> = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((table) =>
      table.foreignKeys.every(
        (key) => key.referencedTable === table || sorted.includes(key.referencedTable),
      ),
    );
    const next = remaining.splice(index === -1 ? 0 : index, 1)[0];
    if (next !== undefined) sorted.push(next);
  }
  return sorted;
};

/**
 * The `CREATE TABLE` (and, on MSSQL, filtered unique index) statements for a
 * schema, in the order they must run.
 */
export const ddlStatements = (provider: Provider, schema: AnySchema): ReadonlyArray<string> => {
  const q = (name: string) => quote(provider, name);
  const statements: Array<string> = [];

  for (const table of sortTables(schema)) {
    const definitions: Array<string> = [];
    const indexes: Array<string> = [];

    for (const column of Object.values(table.columns)) {
      let definition = `${q(column.names.sql)} ${schemaToDbType(column, provider)}`;
      if (!column.isNullable) definition += " not null";
      if (isIdColumn(column)) definition += " primary key";
      else if (column.isUnique) {
        // MSSQL treats NULLs as equal in a unique constraint, so a nullable
        // unique column needs a filtered index instead (like the migrator).
        if (provider === "mssql") {
          indexes.push(
            `create unique index ${q(column.getUniqueConstraintName())} on ${q(table.names.sql)} (${q(
              column.names.sql,
            )}) where ${q(column.names.sql)} is not null`,
          );
        } else definition += " unique";
      }
      definitions.push(definition);
    }

    for (const constraint of table.getUniqueConstraints("table")) {
      const columns = constraint.columns.map((column) => q(column.names.sql)).join(", ");
      definitions.push(`constraint ${q(constraint.name)} unique (${columns})`);
    }

    for (const key of table.foreignKeys) {
      const columns = key.columns.map((column) => q(column.names.sql)).join(", ");
      const referenced = key.referencedColumns.map((column) => q(column.names.sql)).join(", ");
      definitions.push(
        `constraint ${q(key.name)} foreign key (${columns}) references ${q(key.referencedTable.names.sql)} (${referenced})` +
          ` on delete ${action(provider, key.onDelete)} on update ${action(provider, key.onUpdate)}`,
      );
    }

    statements.push(`create table ${q(table.names.sql)} (${definitions.join(", ")})`);
    statements.push(...indexes);
  }

  return statements;
};

/** Create every table of a schema in the connected database. */
export const createTables = (
  provider: Provider,
  schema: AnySchema,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // SQLite ignores foreign keys unless they are enabled per connection.
    if (provider === "sqlite") yield* sql.unsafe("PRAGMA foreign_keys = ON");
    for (const statement of ddlStatements(provider, schema)) {
      yield* sql.unsafe(statement);
    }
  });
