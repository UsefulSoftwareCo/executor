/**
 * The private settings table: `private_<namespace>_settings (key, value)`.
 *
 * FumaDB stores the applied schema version and the name variants that were
 * applied with it, so a later migration can diff against what is really in the
 * database.
 *
 * Reads are ordinary parameterised queries. Writes are produced as literal SQL
 * text and run as part of a migration, so `MigrationResult.sql` stays a
 * runnable script (docs/DESIGN.md).
 *
 * Unlike upstream, a read does not swallow driver errors: it checks that the
 * table exists first, then reads it, so a connection failure stays an
 * `SqlError` (docs/DESIGN.md deviation 4).
 */
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Provider } from "../../contracts/provider.ts";
import { schemaToDbType } from "../schema-codec.ts";
import { quoteIdentifier, quoteStringLiteral } from "./ddl.ts";

/** The SQL name of the settings table for a library namespace. */
export const settingsTableName = (namespace: string): string => `private_${namespace}_settings`;

/** Whether the settings table exists, checked through the provider's catalog. */
export const settingsTableExists = Effect.fn("FumaDB.Sql.settingsTableExists")(function* (
  provider: Provider,
  table: string,
): Effect.fn.Return<boolean, SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const query = (): Effect.Effect<ReadonlyArray<unknown>, SqlError> => {
    switch (provider) {
      case "postgresql":
      case "cockroachdb":
        return sql`
          select 1 as present from information_schema.tables
          where table_schema = current_schema() and table_name = ${table}`;
      case "mysql":
        return sql`
          select 1 as present from information_schema.tables
          where table_schema = database() and table_name = ${table}`;
      case "mssql":
        return sql`select 1 as present from sys.tables where name = ${table}`;
      case "sqlite":
        return sql`
          select 1 as present from sqlite_master where type = 'table' and name = ${table}`;
    }
  };
  const rows = yield* query();
  return rows.length > 0;
});

/**
 * Read one settings value.
 *
 * Returns `None` when the settings table does not exist or has no row for the
 * key. Any other driver failure stays an `SqlError`.
 */
export const getSetting = Effect.fn("FumaDB.Sql.getSetting")(function* (
  provider: Provider,
  table: string,
  key: string,
): Effect.fn.Return<Option.Option<string>, SqlError, SqlClient.SqlClient> {
  const exists = yield* settingsTableExists(provider, table);
  if (!exists) return Option.none();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly value: string }>`
    select ${sql("value")} from ${sql(table)} where ${sql("key")} = ${key}`;
  const first = rows[0];
  return first === undefined ? Option.none() : Option.some(first.value);
});

/** Read the applied schema version, or `None` before initialisation. */
export const getSettingsVersion = (
  provider: Provider,
  table: string,
): Effect.Effect<Option.Option<string>, SqlError, SqlClient.SqlClient> =>
  getSetting(provider, table, "version");

/**
 * Literal `create table` statement for the settings table.
 *
 * The key is `varchar(255)` everywhere except SQLite, which has no `varchar`;
 * the value uses the provider's type for an unbounded string.
 */
export const createSettingsTableStatement = (provider: Provider, table: string): string => {
  const keyType = provider === "sqlite" ? "text" : "varchar(255)";
  const valueType = schemaToDbType({ type: "string" }, provider);
  return `create table ${quoteIdentifier(table, provider)} (${quoteIdentifier(
    "key",
    provider,
  )} ${keyType} primary key, ${quoteIdentifier("value", provider)} ${valueType} not null)`;
};

/** Literal `insert` statement for a settings entry. */
export const insertSettingStatement = (
  provider: Provider,
  table: string,
  key: string,
  value: string,
): string =>
  `insert into ${quoteIdentifier(table, provider)} (${quoteIdentifier("key", provider)}, ${quoteIdentifier(
    "value",
    provider,
  )}) values (${quoteStringLiteral(key, provider)}, ${quoteStringLiteral(value, provider)})`;

/** Literal `update` statement for an existing settings entry. */
export const updateSettingStatement = (
  provider: Provider,
  table: string,
  key: string,
  value: string,
): string =>
  `update ${quoteIdentifier(table, provider)} set ${quoteIdentifier("value", provider)} = ${quoteStringLiteral(
    value,
    provider,
  )} where ${quoteIdentifier("key", provider)} = ${quoteStringLiteral(key, provider)}`;
