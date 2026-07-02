import type * as Drizzle from "drizzle-orm";
import type * as MySQL from "drizzle-orm/mysql-core";

export type TableType = MySQL.MySqlTableWithColumns<MySQL.TableConfig>;
export type ColumnType = MySQL.AnyMySqlColumn;
export type DBType = MySQL.MySqlDatabase<
  MySQL.MySqlQueryResultHKT,
  MySQL.PreparedQueryHKTBase,
  Record<string, unknown>,
  Drizzle.TablesRelationalConfig
>;

export function parseDrizzle(drizzle: unknown) {
  const db = drizzle as DBType;
  const drizzleTables = db._.fullSchema as Record<string, TableType>;
  if (!drizzleTables || Object.keys(drizzleTables).length === 0)
    throw new Error(
      "[fumadb] Drizzle adapter requires query mode, make sure to configure it following their guide: https://orm.drizzle.team/docs/rqb."
    );

  return [db, drizzleTables] as const;
}
