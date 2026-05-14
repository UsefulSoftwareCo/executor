import { Database } from "bun:sqlite";
import { Data } from "effect";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/* oxlint-disable executor/no-json-parse, executor/no-switch-statement, executor/no-try-catch-or-throw -- boundary: one-shot legacy SQLite importer normalizes unknown rows and wraps native sqlite failures */

import {
  withQueryContext,
  type AnyColumn,
  type AnyTable,
  type FumaDb,
  type FumaTables,
} from "@executor-js/sdk";

type SqliteRow = Record<string, unknown>;

type ImportFumaDb = Readonly<{
  createMany: (table: string, rows: SqliteRow[]) => Promise<unknown>;
  transaction: <A>(run: (db: ImportFumaDb) => Promise<A>) => Promise<A>;
}>;

export class LocalSqliteImportError extends Data.TaggedError("LocalSqliteImportError")<{
  readonly message: string;
  readonly sqlitePath: string;
  readonly table?: string;
  readonly cause: unknown;
}> {}

export interface LocalSqliteImportOptions {
  readonly sqlitePath: string;
  readonly markerPath: string;
  readonly db: FumaDb;
  readonly tables: FumaTables;
  readonly scopeId: string;
}

export interface LocalSqliteImportResult {
  readonly imported: boolean;
  readonly importedRows: number;
  readonly importedTables: readonly string[];
  readonly backupPath?: string;
}

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const sqliteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const tableExists = (sqlite: Database, tableName: string): boolean => {
  const row = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tableName);
  return row !== null;
};

const sqliteColumnNames = (sqlite: Database, tableName: string): ReadonlySet<string> => {
  const rows = sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(${sqliteStringLiteral(tableName)})`)
    .all();
  return new Set(rows.map((row) => row.name));
};

const readRows = (sqlite: Database, tableName: string): readonly SqliteRow[] =>
  sqlite.query<SqliteRow, []>(`SELECT * FROM ${quoteIdent(tableName)}`).all();

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const toBigInt = (value: unknown): unknown => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value.trim().length > 0) return BigInt(value);
  return value;
};

const toDate = (value: unknown): unknown => {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return new Date(Number(trimmed));
    return new Date(trimmed);
  }
  return value;
};

const toBool = (value: unknown): unknown => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return value;
};

const defaultColumnValue = (input: {
  readonly tableKey: string;
  readonly columnKey: string;
  readonly row: SqliteRow;
  readonly scopeId: string;
}): unknown => {
  if (input.columnKey === "scope_id") return input.scopeId;
  if (input.tableKey === "blob" && input.columnKey === "id") {
    const namespace = input.row.namespace;
    const key = input.row.key;
    if (typeof namespace === "string" && typeof key === "string") {
      return JSON.stringify([namespace, key]);
    }
  }
  return undefined;
};

const normalizeColumnValue = (value: unknown, column: AnyColumn): unknown => {
  if (value === undefined || value === null) return value;
  switch (column.type) {
    case "bool":
      return toBool(value);
    case "bigint":
      return toBigInt(value);
    case "date":
    case "timestamp":
      return toDate(value);
    case "json":
      return typeof value === "string" ? parseJson(value) : value;
    default:
      return value;
  }
};

const toFumaRow = (input: {
  readonly tableKey: string;
  readonly table: AnyTable;
  readonly sqliteColumns: ReadonlySet<string>;
  readonly row: SqliteRow;
  readonly scopeId: string;
}): SqliteRow => {
  const out: SqliteRow = {};

  for (const [columnKey, column] of Object.entries(input.table.columns)) {
    if (columnKey === "row_id") continue;

    const sqlName = column.names.sql;
    const rawValue = input.sqliteColumns.has(sqlName)
      ? input.row[sqlName]
      : defaultColumnValue({
          tableKey: input.tableKey,
          columnKey,
          row: input.row,
          scopeId: input.scopeId,
        });

    const value = normalizeColumnValue(rawValue, column);
    if (value !== undefined) out[columnKey] = value;
  }

  return out;
};

const moveImportedSqliteAside = (sqlitePath: string): string => {
  const backupPath = `${sqlitePath}.imported-${Date.now()}-${randomBytes(4).toString("hex")}`;
  renameSync(sqlitePath, backupPath);

  for (const suffix of ["-wal", "-shm"]) {
    const source = `${sqlitePath}${suffix}`;
    if (existsSync(source)) renameSync(source, `${backupPath}${suffix}`);
  }

  return backupPath;
};

export const importSqliteDataToFuma = async (
  options: LocalSqliteImportOptions,
): Promise<LocalSqliteImportResult> => {
  if (!existsSync(options.sqlitePath) || existsSync(options.markerPath)) {
    return { imported: false, importedRows: 0, importedTables: [] };
  }

  let sqlite: Database | null = null;

  try {
    sqlite = new Database(options.sqlitePath, { readonly: true });
    const importedTables: string[] = [];
    let importedRows = 0;
    const dbWithScopeContext = withQueryContext(options.db, {
      allowedScopeIds: new Set([options.scopeId]),
    });

    await (dbWithScopeContext as ImportFumaDb).transaction(async (db) => {
      for (const [tableKey, table] of Object.entries(options.tables)) {
        const tableName = table.names.sql;
        if (!tableExists(sqlite!, tableName)) continue;

        const sqliteColumns = sqliteColumnNames(sqlite!, tableName);
        const rows = readRows(sqlite!, tableName).map((row) =>
          toFumaRow({
            tableKey,
            table,
            sqliteColumns,
            row,
            scopeId: options.scopeId,
          }),
        );

        if (rows.length === 0) continue;
        await db.createMany(tableKey, rows);
        importedTables.push(tableKey);
        importedRows += rows.length;
      }
    });

    sqlite.close();
    sqlite = null;

    mkdirSync(dirname(options.markerPath), { recursive: true });
    writeFileSync(
      options.markerPath,
      `${JSON.stringify({ importedAt: new Date().toISOString(), importedRows, importedTables })}\n`,
      { flag: "w" },
    );

    const backupPath = moveImportedSqliteAside(options.sqlitePath);
    return { imported: true, importedRows, importedTables, backupPath };
  } catch (cause) {
    throw new LocalSqliteImportError({
      message: `Failed to import local SQLite data from ${options.sqlitePath}`,
      sqlitePath: options.sqlitePath,
      cause,
    });
  } finally {
    sqlite?.close();
  }
};
