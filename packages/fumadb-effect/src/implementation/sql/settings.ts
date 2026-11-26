import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Provider } from "../../contracts/provider.ts";
import { schemaToDbType } from "../schema-codec.ts";
import { quoteIdentifier, quoteStringLiteral } from "./ddl.ts";

export const settingsTableName = (namespace: string): string => `private_${namespace}_settings`;

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

export const getSettingsVersion = (
  provider: Provider,
  table: string,
): Effect.Effect<Option.Option<string>, SqlError, SqlClient.SqlClient> =>
  getSetting(provider, table, "version");

export const createSettingsTableStatement = (provider: Provider, table: string): string => {
  const keyType = provider === "sqlite" ? "text" : "varchar(255)";
  const valueType = schemaToDbType({ type: "string" }, provider);
  return `create table ${quoteIdentifier(table, provider)} (${quoteIdentifier(
    "key",
    provider,
  )} ${keyType} primary key, ${quoteIdentifier("value", provider)} ${valueType} not null)`;
};

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
