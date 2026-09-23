/**
 * Database introspection: read the live database into a FumaDB schema so the
 * migrator can diff against reality (`mode: "from-database"`).
 *
 * CONTRACT (implemented by the introspect worker; see docs/DESIGN.md).
 */
import { Effect, type Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MigrationError, SchemaDefinitionError } from "../../contracts/errors.ts";
import { generateMigrationFromSchema } from "../migration/diff.ts";
import type { MigrationOperation } from "../../contracts/migration-operation.ts";
import type { Provider } from "../../contracts/provider.ts";
import { type AnyColumn, column, idColumn } from "../../contracts/schema/column.ts";
import {
  inferStorageType,
  isIdStorageType,
  schemaForStorageType,
  type StorageType,
} from "../../contracts/schema/storage.ts";
import { type ColumnMetadata, dbToSchemaType } from "../schema-codec.ts";
import { applyNameVariants, type NameVariantsConfig } from "../../contracts/schema/names.ts";
import type {
  AnyRelationInit,
  ForeignKeyAction,
  RelationBuilder,
} from "../../contracts/schema/relation.ts";
import { type AnySchema, schema as makeSchema } from "../../contracts/schema/schema.ts";
import { type AnyTable, table as makeTable } from "../../contracts/schema/table.ts";
import type { ResolvedSqlAdapterConfig } from "../../contracts/sql.ts";

/**
 * How to read the connected database into a schema.
 *
 * The mapping callbacks let the migrator align the introspected schema with a
 * target schema; with none of them, names pass through unchanged and each
 * column takes the first FumaDB type its raw database type can hold.
 */
export interface IntrospectOptions {
  readonly provider: Provider;
  /** Schema version to stamp on the result. @default "1.0.0" */
  readonly version?: string;
  /** SQL table names to skip (the settings table). @default [] */
  readonly internalTables?: ReadonlyArray<string>;
  /** Map a SQL table name to the ORM name to use. @default identity */
  readonly tableNameMapping?: (tableName: string) => string;
  /** Map a SQL column name to the ORM name to use. @default identity */
  readonly columnNameMapping?: (tableName: string, columnName: string) => string;
  /**
   * Choose the FumaDB type for a database column.
   * @default first candidate of `dbToSchemaType` (for a primary key, the first candidate an id column accepts)
   */
  readonly columnTypeMapping?: (
    dataType: string,
    options: {
      readonly tableName: string;
      readonly columnName: string;
      readonly metadata: ColumnMetadata;
      readonly isPrimaryKey: boolean;
    },
  ) => StorageType;
  /** @default true */
  readonly includeRelations?: boolean;
}

// ---------------------------------------------------------------------------
// Raw catalogue shapes
// ---------------------------------------------------------------------------

/** One column as the database catalogue describes it. */
interface RawColumn {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly metadata: ColumnMetadata;
  readonly defaultValue: string | undefined;
}

/** One base table as the database catalogue describes it. */
interface RawTable {
  readonly name: string;
  /** The owning database schema, when the provider has one. */
  readonly schema: string | undefined;
  readonly columns: ReadonlyArray<RawColumn>;
}

/** A unique constraint or unique index, with its columns in key order. */
interface RawUnique {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
}

/** A foreign key, with its columns in key order. */
interface RawForeignKey {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly referencedTable: string;
  readonly referencedColumns: ReadonlyArray<string>;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

/**
 * Database schemas that never hold user tables. The list covers every provider
 * so one constant serves all catalogue queries.
 */
const internalSchemaList =
  "('pg_catalog', 'pg_toast', 'pg_extension', 'information_schema', 'crdb_internal', 'mysql', 'performance_schema', 'sys')";

const introspectionError = (message: string, cause?: unknown): MigrationError =>
  new MigrationError({
    reason: "Introspection",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** `-1` means "unbounded" on MSSQL and MySQL, so it is reported as absent. */
const optionalNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const converted = Number(value);
  if (Number.isNaN(converted) || converted === -1) return undefined;
  return converted;
};

const optionalText = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

/** Catalogue booleans arrive as `boolean`, `0`/`1`, bigint, or `"YES"`/`"NO"`. */
const toBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === "yes" || normalized === "true" || normalized === "t" || normalized === "1"
    );
  }
  return false;
};

const mapAction = (action: unknown): ForeignKeyAction => {
  switch (optionalText(action)?.toUpperCase().replace(/_/g, " ")) {
    case "CASCADE":
      return "CASCADE";
    case "SET NULL":
      return "SET NULL";
    default:
      // RESTRICT, NO ACTION, NONE, SET DEFAULT, and anything unknown.
      return "RESTRICT";
  }
};

/** Group `{ constraint_name, column_name }` rows, keeping the row order per constraint. */
const groupUniques = (
  rows: ReadonlyArray<{ readonly constraint_name: unknown; readonly column_name: unknown }>,
): ReadonlyArray<RawUnique> => {
  const map = new Map<string, Array<string>>();
  for (const row of rows) {
    const name = optionalText(row.constraint_name);
    const col = optionalText(row.column_name);
    if (name === undefined || col === undefined) continue;
    const existing = map.get(name);
    if (existing === undefined) map.set(name, [col]);
    else existing.push(col);
  }
  return Array.from(map, ([name, columns]) => ({ name, columns }));
};

// ---------------------------------------------------------------------------
// Default value normalisation
// ---------------------------------------------------------------------------

/** A database default, reduced to something a FumaDB column can express. */
type IntrospectedDefault =
  | { readonly _tag: "Now" }
  | { readonly _tag: "Value"; readonly value: unknown };

/**
 * Remove the parentheses MSSQL wraps around every default constraint
 * definition (`('text')`, `((1))`, `(getdate())`).
 */
const stripOuterParens = (input: string): string => {
  let str = input.trim();
  for (;;) {
    if (!(str.startsWith("(") && str.endsWith(")"))) return str;
    let depth = 0;
    let outerClosesAtEnd = true;
    for (let index = 0; index < str.length; index++) {
      const char = str[index];
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0 && index < str.length - 1) {
          outerClosesAtEnd = false;
          break;
        }
      }
    }
    if (!outerClosesAtEnd) return str;
    str = str.slice(1, -1).trim();
  }
};

const parseJson = (str: string): IntrospectedDefault | undefined => {
  try {
    return { _tag: "Value", value: JSON.parse(str) };
  } catch {
    return undefined;
  }
};

const parseBigInt = (str: string): IntrospectedDefault | undefined => {
  // SQLite stores a bigint as an 8-byte big-endian blob and reports the default as `X'...'`.
  const blob = /^[xX]'([0-9a-fA-F]{16})'$/.exec(str);
  if (blob?.[1] !== undefined) {
    const bytes = Uint8Array.from(blob[1].match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    return { _tag: "Value", value: new DataView(bytes.buffer).getBigInt64(0) };
  }
  // MSSQL reports an integer default as a numeric literal (`90071992547409910.`),
  // which `BigInt` rejects; a zero fraction is dropped, anything else is not a bigint.
  const text = /^[+-]?\d+\.0*$/.test(str) ? str.replace(/\.0*$/, "") : str;
  try {
    return { _tag: "Value", value: BigInt(text) };
  } catch {
    return undefined;
  }
};

/**
 * Undo the backslash escapes in a PostgreSQL/CockroachDB escape string
 * (`e'it\'s'`). Unknown escapes yield the escaped character itself, which is
 * what PostgreSQL does.
 */
const unescapeBackslashes = (input: string): string =>
  input.replace(/\\(.)/g, (_match: string, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return char;
    }
  });

/** `YYYY-MM-DD` with an optional `HH:MM[:SS[.fff]]` part and no timezone. */
const naiveDateTime = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;

/**
 * Parse a date or timestamp default.
 *
 * SQLite keeps a `date` or `timestamp` column as epoch milliseconds (the codec
 * matrix in `schema/codec.ts`), and `sql/ddl.ts` writes the default as that
 * number, so an all-digit literal is read back as a timestamp there. Without
 * it a from-database migration on SQLite re-emitted the same default on every
 * run.
 *
 * A literal with no timezone is read as UTC, because that is the convention
 * the whole package uses for a naive database timestamp. `new Date("2020-01-02
 * 00:00:00")` would instead read it in the host timezone, so every
 * from-database migration would re-emit the same default change.
 */
const parseDate = (str: string, provider: Provider): IntrospectedDefault | undefined => {
  if (provider === "sqlite" && /^[+-]?\d+$/.test(str)) {
    const epoch = new Date(Number(str));
    return Number.isNaN(epoch.getTime()) ? undefined : { _tag: "Value", value: epoch };
  }
  const naive = naiveDateTime.exec(str);
  const day = naive?.[1];
  const parsed = new Date(day === undefined ? str : `${day}T${naive?.[2] ?? "00:00:00"}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : { _tag: "Value", value: parsed };
};

/**
 * Turn a raw database default into a FumaDB default.
 *
 * Returns `undefined` when the default is absent or cannot be represented
 * (a sequence, an expression, an unparsable literal); the column then simply
 * has no default, which is safer than failing the whole introspection.
 */
const normalizeDefault = (
  raw: unknown,
  type: StorageType,
  provider: Provider,
): IntrospectedDefault | undefined => {
  if (raw === null || raw === undefined) return undefined;
  let str = stripOuterParens(String(raw).trim());
  if (str.length === 0) return undefined;

  if (
    (type === "date" || type === "timestamp") &&
    /^(CURRENT_TIMESTAMP|now\(\)|datetime\('now'\)|getdate\(\))/i.test(str)
  ) {
    return { _tag: "Now" };
  }

  // Drop a trailing cast: `::text` on PostgreSQL, `:::STRING` on CockroachDB.
  str = str.replace(/:{2,3}[\w\s[\]."]+$/, "").trim();
  if (/^[eE]'/.test(str) && str.endsWith("'") && str.length >= 3) {
    // PostgreSQL/CockroachDB escape string; CockroachDB renders the prefix in
    // lower case and escapes an embedded quote with a backslash.
    str = unescapeBackslashes(str.slice(2, -1).replace(/''/g, "'"));
  } else if (/^[nN]'/.test(str) && str.endsWith("'") && str.length >= 3) {
    // MSSQL national string; only `''` is an escape.
    str = str.slice(2, -1).replace(/''/g, "'");
  } else if (str.startsWith("'") && str.endsWith("'") && str.length >= 2) {
    str = str.slice(1, -1).replace(/''/g, "'");
  } else if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
    str = str.slice(1, -1);
  } else if (str.toLowerCase() === "null") {
    return undefined;
  }

  switch (type) {
    case "bool":
      if (str === "true" || str === "1") return { _tag: "Value", value: true };
      if (str === "false" || str === "0") return { _tag: "Value", value: false };
      return undefined;
    case "integer":
    case "decimal": {
      const parsed = Number(str);
      return Number.isNaN(parsed) ? undefined : { _tag: "Value", value: parsed };
    }
    case "json":
      return parseJson(str);
    case "bigint":
      return parseBigInt(str);
    case "date":
    case "timestamp":
      return parseDate(str, provider);
    case "string":
      return { _tag: "Value", value: str };
    default:
      return type.startsWith("varchar") ? { _tag: "Value", value: str } : undefined;
  }
};

// ---------------------------------------------------------------------------
// Column type selection
// ---------------------------------------------------------------------------

const isVarcharType = (type: StorageType | "varchar(n)"): type is `varchar(${number})` =>
  type !== "varchar(n)" && type.startsWith("varchar(");

/**
 * `sys.columns.max_length` counts bytes; `nvarchar` and `nchar` store two
 * bytes per character, and `-1` means `max`.
 */
const nvarcharLength = (dataType: string, bytes: number | undefined): number | undefined => {
  if (bytes === undefined || bytes < 0) return undefined;
  const type = dataType.toLowerCase();
  return type === "nvarchar" || type === "nchar" ? bytes / 2 : bytes;
};

/** `varchar(n)` stands for "a varchar of unknown length"; 255 is FumaDB's recommended width. */
const resolveVarchar = (type: StorageType | "varchar(n)"): StorageType =>
  type === "varchar(n)" ? "varchar(255)" : type;

/**
 * The FumaDB type used when the caller gives no `columnTypeMapping`.
 *
 * It is the first candidate of {@link dbToSchemaType}, except for a primary
 * key, where the first candidate that an id column accepts (`varchar(n)` or
 * `uuid`) wins. Without that rule every text primary key on SQLite would be
 * read as `json`.
 */
const defaultStorageType = (
  dataType: string,
  provider: Provider,
  options: { readonly metadata: ColumnMetadata; readonly isPrimaryKey: boolean },
): StorageType => {
  const candidates = dbToSchemaType(dataType, provider, options.metadata);
  if (options.isPrimaryKey) {
    for (const candidate of candidates) {
      if (candidate === "varchar(n)" || candidate === "uuid" || isVarcharType(candidate))
        return resolveVarchar(candidate);
    }
  }
  const first = candidates[0];
  return first === undefined ? "string" : resolveVarchar(first);
};

// ---------------------------------------------------------------------------
// Catalogue queries
// ---------------------------------------------------------------------------

/** Every base table with its columns, ordered by table then column position. */
const listTables = Effect.fnUntraced(function* (provider: Provider) {
  const sql = yield* SqlClient;

  switch (provider) {
    case "postgresql":
    case "mysql": {
      const rows = yield* sql<{
        table_schema: unknown;
        table_name: unknown;
        column_name: unknown;
        data_type: unknown;
        is_nullable: unknown;
        col_length: unknown;
        col_precision: unknown;
        col_scale: unknown;
        column_default: unknown;
      }>`
        SELECT
          c.table_schema AS table_schema,
          c.table_name AS table_name,
          c.column_name AS column_name,
          c.data_type AS data_type,
          c.is_nullable AS is_nullable,
          c.character_maximum_length AS col_length,
          c.numeric_precision AS col_precision,
          c.numeric_scale AS col_scale,
          c.column_default AS column_default
        FROM information_schema.columns c
        INNER JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ${sql.literal(internalSchemaList)}
          ${sql.literal(provider === "mysql" ? "AND c.table_schema = DATABASE()" : "")}
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
      return collectTables(
        rows.map((row) => ({
          table: optionalText(row.table_name) ?? "",
          schema: optionalText(row.table_schema),
          column: {
            name: optionalText(row.column_name) ?? "",
            dataType: optionalText(row.data_type) ?? "",
            isNullable: toBoolean(row.is_nullable),
            metadata: {
              // sys.columns.max_length is in bytes; nvarchar stores two per character.
              length: nvarcharLength(String(row.data_type ?? ""), optionalNumber(row.col_length)),
              precision: optionalNumber(row.col_precision),
              scale: optionalNumber(row.col_scale),
            },
            defaultValue: optionalText(row.column_default),
          },
        })),
      );
    }
    case "cockroachdb": {
      // CockroachDB's information_schema also lists `crdb_internal` tables and
      // reports a normalised `data_type`, so the table list comes from
      // pg_catalog (like upstream's CockroachIntrospector) and only the length,
      // precision, scale, and default come from information_schema.
      const columns = yield* sql<{
        table_schema: unknown;
        table_name: unknown;
        column_name: unknown;
        data_type: unknown;
        not_null: unknown;
      }>`
        SELECT
          ns.nspname AS table_schema,
          c.relname AS table_name,
          a.attname AS column_name,
          typ.typname AS data_type,
          a.attnotnull AS not_null
        FROM pg_catalog.pg_attribute a
        INNER JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
        INNER JOIN pg_catalog.pg_namespace ns ON c.relnamespace = ns.oid
        INNER JOIN pg_catalog.pg_type typ ON a.atttypid = typ.oid
        WHERE c.relkind IN ('r', 'p')
          AND ns.nspname NOT IN ${sql.literal(internalSchemaList)}
          AND a.attnum > 0
          AND a.attisdropped = false
        ORDER BY ns.nspname, c.relname, a.attnum`;
      const extras = yield* sql<{
        table_schema: unknown;
        table_name: unknown;
        column_name: unknown;
        col_length: unknown;
        col_precision: unknown;
        col_scale: unknown;
        column_default: unknown;
      }>`
        SELECT
          table_schema AS table_schema,
          table_name AS table_name,
          column_name AS column_name,
          character_maximum_length AS col_length,
          numeric_precision AS col_precision,
          numeric_scale AS col_scale,
          column_default AS column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ${sql.literal(internalSchemaList)}`;
      const extraByKey = new Map<string, (typeof extras)[number]>();
      for (const extra of extras) {
        extraByKey.set(
          `${optionalText(extra.table_schema) ?? ""}.${optionalText(extra.table_name) ?? ""}.${optionalText(extra.column_name) ?? ""}`,
          extra,
        );
      }
      return collectTables(
        columns.map((row) => {
          const schemaName = optionalText(row.table_schema);
          const tableName = optionalText(row.table_name) ?? "";
          const columnName = optionalText(row.column_name) ?? "";
          const extra = extraByKey.get(`${schemaName ?? ""}.${tableName}.${columnName}`);
          return {
            table: tableName,
            schema: schemaName,
            column: {
              name: columnName,
              dataType: optionalText(row.data_type) ?? "",
              isNullable: !toBoolean(row.not_null),
              metadata: {
                length: optionalNumber(extra?.col_length),
                precision: optionalNumber(extra?.col_precision),
                scale: optionalNumber(extra?.col_scale),
              },
              defaultValue: optionalText(extra?.column_default),
            },
          };
        }),
      );
    }
    case "mssql": {
      const rows = yield* sql<{
        table_schema: unknown;
        table_name: unknown;
        column_name: unknown;
        data_type: unknown;
        is_nullable: unknown;
        col_length: unknown;
        col_precision: unknown;
        col_scale: unknown;
        column_default: unknown;
      }>`
        SELECT
          s.name AS table_schema,
          t.name AS table_name,
          c.name AS column_name,
          ty.name AS data_type,
          c.is_nullable AS is_nullable,
          c.max_length AS col_length,
          c.precision AS col_precision,
          c.scale AS col_scale,
          d.definition AS column_default
        FROM sys.columns c
        INNER JOIN sys.tables t ON c.object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        LEFT JOIN sys.default_constraints d ON c.default_object_id = d.object_id
        WHERE t.is_ms_shipped = 0 AND s.name NOT IN ${sql.literal(internalSchemaList)}
        ORDER BY s.name, t.name, c.column_id`;
      return collectTables(
        rows.map((row) => ({
          table: optionalText(row.table_name) ?? "",
          schema: optionalText(row.table_schema),
          column: {
            name: optionalText(row.column_name) ?? "",
            dataType: optionalText(row.data_type) ?? "",
            isNullable: toBoolean(row.is_nullable),
            metadata: {
              // sys.columns.max_length is in bytes; nvarchar stores two per character.
              length: nvarcharLength(String(row.data_type ?? ""), optionalNumber(row.col_length)),
              precision: optionalNumber(row.col_precision),
              scale: optionalNumber(row.col_scale),
            },
            defaultValue: optionalText(row.column_default),
          },
        })),
      );
    }
    case "sqlite": {
      const names = yield* sql<{ name: unknown }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
      const tables: Array<RawTable> = [];
      for (const row of names) {
        const tableName = optionalText(row.name);
        if (tableName === undefined) continue;
        const columns = yield* sql<{
          name: unknown;
          type: unknown;
          not_null: unknown;
          dflt_value: unknown;
        }>`
          SELECT name, type, "notnull" AS not_null, dflt_value FROM pragma_table_info(${tableName})`;
        tables.push({
          name: tableName,
          schema: undefined,
          columns: columns.flatMap((col) => {
            const columnName = optionalText(col.name);
            if (columnName === undefined) return [];
            return [
              {
                name: columnName,
                dataType: optionalText(col.type) ?? "",
                isNullable: !toBoolean(col.not_null),
                // SQLite stores no length, precision, or scale.
                metadata: {},
                defaultValue: optionalText(col.dflt_value),
              },
            ];
          }),
        });
      }
      return tables as ReadonlyArray<RawTable>;
    }
  }
});

const collectTables = (
  rows: ReadonlyArray<{
    readonly table: string;
    readonly schema: string | undefined;
    readonly column: RawColumn;
  }>,
): ReadonlyArray<RawTable> => {
  const tables: Array<{ name: string; schema: string | undefined; columns: Array<RawColumn> }> = [];
  for (const row of rows) {
    if (row.table === "" || row.column.name === "") continue;
    let table = tables.find((item) => item.name === row.table && item.schema === row.schema);
    if (table === undefined) {
      table = { name: row.table, schema: row.schema, columns: [] };
      tables.push(table);
    }
    table.columns.push(row.column);
  }
  return tables;
};

/** Primary key columns, in key order. FumaDB supports exactly one. */
const listPrimaryKeys = Effect.fnUntraced(function* (provider: Provider, table: RawTable) {
  const sql = yield* SqlClient;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
    case "mysql": {
      const rows = yield* sql<{ column_name: unknown }>`
        SELECT kcu.column_name AS column_name
        FROM information_schema.table_constraints tc
        INNER JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = ${table.name}
          AND tc.table_schema = ${table.schema ?? ""}
        ORDER BY kcu.ordinal_position`;
      return rows.flatMap((row) => optionalText(row.column_name) ?? []);
    }
    case "mssql": {
      const rows = yield* sql<{ column_name: unknown }>`
        SELECT c.name AS column_name
        FROM sys.key_constraints kc
        INNER JOIN sys.index_columns ic
          ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        INNER JOIN sys.tables t ON kc.parent_object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE kc.type = 'PK' AND t.name = ${table.name} AND s.name = ${table.schema ?? "dbo"}
        ORDER BY ic.key_ordinal`;
      return rows.flatMap((row) => optionalText(row.column_name) ?? []);
    }
    case "sqlite": {
      const rows = yield* sql<{ name: unknown; pk: unknown }>`
        SELECT name, pk FROM pragma_table_info(${table.name}) WHERE pk > 0 ORDER BY pk`;
      return rows.flatMap((row) => optionalText(row.name) ?? []);
    }
  }
});

/** Declared unique constraints (not unique indexes). */
const listUniqueConstraints = Effect.fnUntraced(function* (provider: Provider, table: RawTable) {
  const sql = yield* SqlClient;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
    case "mysql": {
      const rows = yield* sql<{ constraint_name: unknown; column_name: unknown }>`
        SELECT tc.constraint_name AS constraint_name, kcu.column_name AS column_name
        FROM information_schema.table_constraints tc
        INNER JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_name = ${table.name}
          AND tc.table_schema = ${table.schema ?? ""}
        ORDER BY tc.constraint_name, kcu.ordinal_position`;
      return groupUniques(rows);
    }
    case "mssql": {
      const rows = yield* sql<{ constraint_name: unknown; column_name: unknown }>`
        SELECT kc.name AS constraint_name, c.name AS column_name
        FROM sys.key_constraints kc
        INNER JOIN sys.index_columns ic
          ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        INNER JOIN sys.tables t ON kc.parent_object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE kc.type = 'UQ' AND t.name = ${table.name} AND s.name = ${table.schema ?? "dbo"}
        ORDER BY kc.name, ic.key_ordinal`;
      return groupUniques(rows);
    }
    case "sqlite":
      // SQLite exposes table-level UNIQUE only as an index; see listUniqueIndexes.
      return [];
  }
});

/**
 * Unique indexes that do not back a primary key or a unique constraint.
 *
 * MSSQL and SQLite are the providers whose FumaDB DDL creates unique indexes
 * instead of constraints.
 */
const listUniqueIndexes = Effect.fnUntraced(function* (provider: Provider, table: RawTable) {
  const sql = yield* SqlClient;
  switch (provider) {
    case "mssql": {
      const rows = yield* sql<{ constraint_name: unknown; column_name: unknown }>`
        SELECT i.name AS constraint_name, c.name AS column_name
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        INNER JOIN sys.tables t ON i.object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE i.is_unique = 1
          AND ic.is_included_column = 0
          AND t.name = ${table.name}
          AND s.name = ${table.schema ?? "dbo"}
          AND i.index_id NOT IN (
            SELECT kc.unique_index_id FROM sys.key_constraints kc
            WHERE kc.parent_object_id = t.object_id AND kc.unique_index_id IS NOT NULL
          )
        ORDER BY i.name, ic.key_ordinal`;
      return groupUniques(rows);
    }
    case "sqlite": {
      // `origin = 'pk'` is the implicit index behind the primary key; it is not
      // a unique constraint of its own and must not enter the schema.
      const indexes = yield* sql<{ name: unknown; is_unique: unknown; origin: unknown }>`
        SELECT name, "unique" AS is_unique, origin FROM pragma_index_list(${table.name})`;
      const result: Array<RawUnique> = [];
      for (const index of indexes) {
        const name = optionalText(index.name);
        if (
          name === undefined ||
          !toBoolean(index.is_unique) ||
          optionalText(index.origin) === "pk"
        )
          continue;
        const columns = yield* sql<{ name: unknown }>`
          SELECT name FROM pragma_index_info(${name}) ORDER BY seqno`;
        result.push({ name, columns: columns.flatMap((col) => optionalText(col.name) ?? []) });
      }
      return result as ReadonlyArray<RawUnique>;
    }
    case "postgresql":
    case "cockroachdb":
    case "mysql":
      return [];
  }
});

const sqliteIdentifier = String.raw`"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*`;

const unquoteSqlite = (raw: string): string => {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/""/g, '"');
  if (value.startsWith("`") && value.endsWith("`")) return value.slice(1, -1).replace(/``/g, "`");
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
};

/**
 * Recover foreign key constraint names from the stored `CREATE TABLE` text.
 *
 * `PRAGMA foreign_key_list` reports actions and columns but never the
 * constraint name, and the migration diff matches foreign keys by name.
 */
const sqliteForeignKeyNames = Effect.fnUntraced(function* (tableName: string) {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ sql: unknown }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`;
  const ddl = optionalText(rows[0]?.sql);
  const names = new Map<string, string>();
  if (ddl === undefined) return names;
  const pattern = new RegExp(
    String.raw`constraint\s+(${sqliteIdentifier})\s+foreign\s+key\s*\(([^)]*)\)\s*references\s+(${sqliteIdentifier})`,
    "gi",
  );
  for (const match of ddl.matchAll(pattern)) {
    const [, name, columns, referenced] = match;
    if (name === undefined || columns === undefined || referenced === undefined) continue;
    const key = `${columns
      .split(",")
      .map((col) => unquoteSqlite(col))
      .join(",")}->${unquoteSqlite(referenced)}`;
    names.set(key, unquoteSqlite(name));
  }
  return names;
});

/** Foreign keys declared on `table`, with their columns in key order. */
const listForeignKeys = Effect.fnUntraced(function* (provider: Provider, table: RawTable) {
  const sql = yield* SqlClient;
  switch (provider) {
    case "postgresql":
    case "cockroachdb": {
      const rows = yield* sql<{
        name: unknown;
        column_name: unknown;
        referenced_table: unknown;
        referenced_constraint: unknown;
        referenced_schema: unknown;
        on_update: unknown;
        on_delete: unknown;
      }>`
        SELECT
          tc.constraint_name AS name,
          kcu.column_name AS column_name,
          ref.table_name AS referenced_table,
          rc.unique_constraint_name AS referenced_constraint,
          rc.unique_constraint_schema AS referenced_schema,
          rc.update_rule AS on_update,
          rc.delete_rule AS on_delete
        FROM information_schema.table_constraints tc
        INNER JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.table_name = kcu.table_name
        INNER JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
        INNER JOIN information_schema.table_constraints ref
          ON rc.unique_constraint_name = ref.constraint_name
          AND rc.unique_constraint_schema = ref.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = ${table.name}
          AND tc.table_schema = ${table.schema ?? ""}
        ORDER BY tc.constraint_name, kcu.ordinal_position`;

      const pending = new Map<
        string,
        {
          columns: Array<string>;
          referencedTable: string;
          referencedConstraint: string;
          referencedSchema: string;
          onUpdate: ForeignKeyAction;
          onDelete: ForeignKeyAction;
        }
      >();
      for (const row of rows) {
        const name = optionalText(row.name);
        const columnName = optionalText(row.column_name);
        if (name === undefined || columnName === undefined) continue;
        const existing = pending.get(name);
        if (existing !== undefined) {
          existing.columns.push(columnName);
          continue;
        }
        pending.set(name, {
          columns: [columnName],
          referencedTable: optionalText(row.referenced_table) ?? "",
          referencedConstraint: optionalText(row.referenced_constraint) ?? "",
          referencedSchema: optionalText(row.referenced_schema) ?? "",
          onUpdate: mapAction(row.on_update),
          onDelete: mapAction(row.on_delete),
        });
      }

      const keys: Array<RawForeignKey> = [];
      for (const [name, value] of pending) {
        const referencedColumns = yield* sql<{ column_name: unknown }>`
          SELECT column_name AS column_name
          FROM information_schema.key_column_usage
          WHERE constraint_name = ${value.referencedConstraint}
            AND constraint_schema = ${value.referencedSchema}
            AND table_name = ${value.referencedTable}
          ORDER BY ordinal_position`;
        keys.push({
          name,
          columns: value.columns,
          referencedTable: value.referencedTable,
          referencedColumns: referencedColumns.flatMap(
            (row) => optionalText(row.column_name) ?? [],
          ),
          onUpdate: value.onUpdate,
          onDelete: value.onDelete,
        });
      }
      return keys as ReadonlyArray<RawForeignKey>;
    }
    case "mysql": {
      const rows = yield* sql<{
        name: unknown;
        column_name: unknown;
        referenced_table: unknown;
        referenced_column: unknown;
        on_update: unknown;
        on_delete: unknown;
      }>`
        SELECT
          kcu.constraint_name AS name,
          kcu.column_name AS column_name,
          kcu.referenced_table_name AS referenced_table,
          kcu.referenced_column_name AS referenced_column,
          rc.update_rule AS on_update,
          rc.delete_rule AS on_delete
        FROM information_schema.key_column_usage kcu
        INNER JOIN information_schema.referential_constraints rc
          ON kcu.constraint_name = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
          AND kcu.table_name = rc.table_name
        WHERE kcu.table_name = ${table.name}
          AND kcu.table_schema = ${table.schema ?? ""}
          AND kcu.referenced_table_name IS NOT NULL
        ORDER BY kcu.constraint_name, kcu.ordinal_position`;
      return collectForeignKeyRows(rows);
    }
    case "mssql": {
      const rows = yield* sql<{
        name: unknown;
        column_name: unknown;
        referenced_table: unknown;
        referenced_column: unknown;
        on_update: unknown;
        on_delete: unknown;
      }>`
        SELECT
          fk.name AS name,
          c.name AS column_name,
          rt.name AS referenced_table,
          rc.name AS referenced_column,
          fk.update_referential_action_desc AS on_update,
          fk.delete_referential_action_desc AS on_delete
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        INNER JOIN sys.tables t ON fk.parent_object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        INNER JOIN sys.columns c
          ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
        INNER JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
        INNER JOIN sys.columns rc
          ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
        WHERE t.name = ${table.name} AND s.name = ${table.schema ?? "dbo"}
        ORDER BY fk.name, fkc.constraint_column_id`;
      return collectForeignKeyRows(rows);
    }
    case "sqlite": {
      const names = yield* sqliteForeignKeyNames(table.name);
      const rows = yield* sql<{
        id: unknown;
        table: unknown;
        from: unknown;
        to: unknown;
        on_update: unknown;
        on_delete: unknown;
      }>`
        SELECT id, "table", "from", "to", on_update, on_delete
        FROM pragma_foreign_key_list(${table.name})
        ORDER BY id, seq`;
      const pending = new Map<
        string,
        {
          columns: Array<string>;
          referencedTable: string;
          referencedColumns: Array<string>;
          onUpdate: ForeignKeyAction;
          onDelete: ForeignKeyAction;
        }
      >();
      for (const row of rows) {
        const id = optionalText(row.id);
        const from = optionalText(row.from);
        if (id === undefined || from === undefined) continue;
        const to = optionalText(row.to);
        const existing = pending.get(id);
        if (existing !== undefined) {
          existing.columns.push(from);
          if (to !== undefined) existing.referencedColumns.push(to);
          continue;
        }
        pending.set(id, {
          columns: [from],
          referencedTable: optionalText(row.table) ?? "",
          referencedColumns: to === undefined ? [] : [to],
          onUpdate: mapAction(row.on_update),
          onDelete: mapAction(row.on_delete),
        });
      }
      return Array.from(pending, ([id, value]): RawForeignKey => ({
        name:
          names.get(`${value.columns.join(",")}->${value.referencedTable}`) ??
          `fk_${table.name}_${id}`,
        columns: value.columns,
        referencedTable: value.referencedTable,
        referencedColumns: value.referencedColumns,
        onUpdate: value.onUpdate,
        onDelete: value.onDelete,
      })) as ReadonlyArray<RawForeignKey>;
    }
  }
});

const collectForeignKeyRows = (
  rows: ReadonlyArray<{
    readonly name: unknown;
    readonly column_name: unknown;
    readonly referenced_table: unknown;
    readonly referenced_column: unknown;
    readonly on_update: unknown;
    readonly on_delete: unknown;
  }>,
): ReadonlyArray<RawForeignKey> => {
  const pending = new Map<
    string,
    {
      columns: Array<string>;
      referencedTable: string;
      referencedColumns: Array<string>;
      onUpdate: ForeignKeyAction;
      onDelete: ForeignKeyAction;
    }
  >();
  for (const row of rows) {
    const name = optionalText(row.name);
    const columnName = optionalText(row.column_name);
    if (name === undefined || columnName === undefined) continue;
    const referencedColumn = optionalText(row.referenced_column);
    const existing = pending.get(name);
    if (existing !== undefined) {
      existing.columns.push(columnName);
      if (referencedColumn !== undefined) existing.referencedColumns.push(referencedColumn);
      continue;
    }
    pending.set(name, {
      columns: [columnName],
      referencedTable: optionalText(row.referenced_table) ?? "",
      referencedColumns: referencedColumn === undefined ? [] : [referencedColumn],
      onUpdate: mapAction(row.on_update),
      onDelete: mapAction(row.on_delete),
    });
  }
  return Array.from(pending, ([name, value]) => ({ name, ...value }));
};

// ---------------------------------------------------------------------------
// Schema construction
// ---------------------------------------------------------------------------

/**
 * Pass an explicit `{ type }` only when the schema alone would infer a
 * different storage type (a `date` column reads back as a `Schema.Date`, which
 * infers `timestamp`). Every other introspected column counts as inferred, so a
 * SQLite `text` foreign key can adopt the `varchar(255)` width of the id it
 * references; SQLite cannot tell the two apart.
 */
const storageOptions = (
  schema: Schema.Top,
  columnType: StorageType,
): { type: StorageType } | undefined =>
  inferStorageType(schema).type === columnType ? undefined : { type: columnType };

const buildColumn = (
  raw: RawColumn,
  columnType: StorageType,
  isPrimaryKey: boolean,
  tableName: string,
  provider: Provider,
): AnyColumn => {
  const normalized = normalizeDefault(raw.defaultValue, columnType, provider);
  if (isPrimaryKey) {
    if (!isIdStorageType(columnType)) {
      throw new SchemaDefinitionError(
        `Column "${tableName}"."${raw.name}" is a primary key of type "${columnType}"; an id column only supports varchar and uuid.`,
      );
    }
    const idSchema = schemaForStorageType(columnType, false);
    const id = idColumn(raw.name, idSchema, storageOptions(idSchema, columnType));
    if (normalized?._tag === "Value" && typeof normalized.value === "string")
      id.default(normalized.value);
    return id;
  }
  const colSchema = schemaForStorageType(columnType, raw.isNullable);
  const col = column(raw.name, colSchema, storageOptions(colSchema, columnType));
  if (normalized?._tag === "Now") col.now();
  else if (normalized?._tag === "Value") col.default(normalized.value);
  return col;
};

/**
 * Read the connected database into a FumaDB schema.
 *
 * Every base table outside the provider's internal schemas becomes a table.
 * Primary keys become id columns, unique constraints and unique indexes become
 * table-level unique constraints (so their names survive a round trip), and
 * foreign keys become explicit `one` relations named after the constraint
 * without its `_fk` suffix.
 *
 * Fails with `MigrationError` (`reason: "Introspection"`) when the database
 * cannot be expressed as a FumaDB schema, for example a table without exactly
 * one primary key column, or an id column that is neither `varchar` nor
 * `uuid`. Driver failures stay `SqlError`.
 */
export const introspectSchema: (
  options: IntrospectOptions,
) => Effect.Effect<AnySchema, MigrationError | SqlError, SqlClient> = Effect.fn(
  "FumaDB.Introspect.introspectSchema",
)(function* (options: IntrospectOptions) {
  const {
    columnNameMapping = (_tableName: string, columnName: string) => columnName,
    columnTypeMapping,
    includeRelations = true,
    internalTables = [],
    provider,
    tableNameMapping = (tableName: string) => tableName,
    version = "1.0.0",
  } = options;

  const rawTables = (yield* listTables(provider)).filter(
    (table) => !internalTables.includes(table.name),
  );

  const tables: Record<string, AnyTable> = {};
  const foreignKeysByOrmName = new Map<string, ReadonlyArray<RawForeignKey>>();
  const sqlNameToTable = new Map<string, AnyTable>();

  for (const rawTable of rawTables) {
    const primaryKeys = yield* listPrimaryKeys(provider, rawTable);
    if (primaryKeys.length !== 1) {
      return yield* introspectionError(
        `FumaDB supports exactly one primary key column (the id column); table "${rawTable.name}" has ${primaryKeys.length}.`,
      );
    }

    const uniques: Array<RawUnique> = [...(yield* listUniqueConstraints(provider, rawTable))];
    for (const index of yield* listUniqueIndexes(provider, rawTable)) {
      if (uniques.some((con) => con.name === index.name)) continue;
      uniques.push(index);
    }

    const columns: Record<string, AnyColumn> = {};
    for (const rawColumn of rawTable.columns) {
      const isPrimaryKey = primaryKeys.includes(rawColumn.name);
      const columnType =
        columnTypeMapping === undefined
          ? defaultStorageType(rawColumn.dataType, provider, {
              metadata: rawColumn.metadata,
              isPrimaryKey,
            })
          : columnTypeMapping(rawColumn.dataType, {
              tableName: rawTable.name,
              columnName: rawColumn.name,
              metadata: rawColumn.metadata,
              isPrimaryKey,
            });
      const built = yield* Effect.try({
        try: () => buildColumn(rawColumn, columnType, isPrimaryKey, rawTable.name, provider),
        catch: (cause) =>
          introspectionError(
            cause instanceof SchemaDefinitionError
              ? cause.message
              : `Failed to read column "${rawTable.name}"."${rawColumn.name}" of type "${rawColumn.dataType}".`,
            cause,
          ),
      });
      columns[columnNameMapping(rawTable.name, rawColumn.name)] = built;
    }

    const ormName = tableNameMapping(rawTable.name);
    const built = yield* Effect.try({
      try: () => {
        const table = makeTable(rawTable.name, columns);
        // Every unique constraint is table-level so that custom names survive.
        for (const con of uniques) {
          // The database already has this index, so the indexability guard does not apply.
          table.uniqueUnchecked(
            con.name,
            con.columns.map((col) => columnNameMapping(rawTable.name, col)),
          );
        }
        return table;
      },
      catch: (cause) =>
        introspectionError(
          cause instanceof SchemaDefinitionError
            ? cause.message
            : `Failed to read table "${rawTable.name}".`,
          cause,
        ),
    });

    // The relation builders below address tables by ORM name, and `schema()`
    // names its own copies rather than these.
    built.ormName = ormName;
    tables[ormName] = built;
    sqlNameToTable.set(rawTable.name, built);
    foreignKeysByOrmName.set(ormName, yield* listForeignKeys(provider, rawTable));
  }

  const relations: Record<
    string,
    (
      builder: RelationBuilder<Record<string, AnyTable>, string>,
    ) => Record<string, AnyRelationInit<Record<string, AnyTable>>>
  > = {};

  if (includeRelations) {
    for (const [ormName, table] of Object.entries(tables)) {
      const keys = foreignKeysByOrmName.get(ormName) ?? [];
      const definitions: Array<{
        readonly name: string;
        readonly key: RawForeignKey;
        readonly target: AnyTable;
        readonly on: ReadonlyArray<readonly [string, string]>;
      }> = [];
      for (const key of keys) {
        const target = sqlNameToTable.get(key.referencedTable);
        if (target === undefined) {
          return yield* introspectionError(
            `Foreign key "${key.name}" on table "${table.names.sql}" references "${key.referencedTable}", which was not introspected.`,
          );
        }
        const on: Array<readonly [string, string]> = [];
        for (let index = 0; index < key.columns.length; index++) {
          const columnName = key.columns[index];
          const referencedName = key.referencedColumns[index];
          const local = columnName === undefined ? undefined : table.getColumnBySqlName(columnName);
          const remote =
            referencedName === undefined ? undefined : target.getColumnBySqlName(referencedName);
          if (local === undefined || remote === undefined) {
            return yield* introspectionError(
              `Foreign key "${key.name}" on table "${table.names.sql}" references a column that was not introspected.`,
            );
          }
          on.push([local.ormName, remote.ormName]);
        }
        // Upstream names the relation after the constraint without its `_fk` suffix.
        const relationName = key.name.endsWith("_fk") ? key.name.slice(0, -"_fk".length) : key.name;
        definitions.push({ name: relationName, key, target, on });
      }
      if (definitions.length === 0) continue;
      relations[ormName] = (builder) => {
        const output: Record<string, AnyRelationInit<Record<string, AnyTable>>> = {};
        for (const definition of definitions) {
          output[definition.name] = builder
            .one(definition.target.ormName, ...definition.on)
            .foreignKey({
              name: definition.key.name,
              onDelete: definition.key.onDelete,
              onUpdate: definition.key.onUpdate,
            });
        }
        return output;
      };
    }
  }

  return yield* Effect.try({
    try: () => makeSchema({ version, tables, relations }),
    catch: (cause) =>
      introspectionError(
        cause instanceof SchemaDefinitionError
          ? `The database cannot be expressed as a FumaDB schema: ${cause.message}`
          : "The database cannot be expressed as a FumaDB schema.",
        cause,
      ),
  });
});

/**
 * Diff the live database against `target`, like upstream
 * `adapters/kysely/migration/auto-from-database.ts`.
 *
 * `nameVariants` are the variants the last migration stored, so they describe
 * the names the database uses now; `target` carries the names it must use
 * afterwards. Database columns are therefore matched to ORM names through the
 * stored variants, and the target's column type wins whenever the raw database
 * type can carry it, so a lossless representation is not reported as a change.
 *
 * Tables the target does not know are never dropped (`dropUnusedTables: false`);
 * a column the target does not know is dropped only when `dropUnusedColumns`
 * is set. Otherwise it is kept, and made nullable when it is required.
 */
export const generateMigrationFromDatabase: (
  target: AnySchema,
  config: ResolvedSqlAdapterConfig,
  options: {
    readonly nameVariants: NameVariantsConfig | undefined;
    readonly dropUnusedColumns: boolean;
    readonly internalTables: ReadonlyArray<string>;
  },
) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError, SqlClient> =
  Effect.fn("FumaDB.Introspect.generateMigrationFromDatabase")(function* (
    target: AnySchema,
    config: ResolvedSqlAdapterConfig,
    options: {
      readonly nameVariants: NameVariantsConfig | undefined;
      readonly dropUnusedColumns: boolean;
      readonly internalTables: ReadonlyArray<string>;
    },
  ) {
    const { dropUnusedColumns, internalTables, nameVariants } = options;
    // The stored variants describe the names the database currently uses; the
    // target carries the names it should use after the migration.
    const stored = nameVariants === undefined ? target : applyNameVariants(target, nameVariants);

    const ormNameOf = new Map<string, string>();
    for (const table of Object.values(stored.tables)) ormNameOf.set(table.names.sql, table.ormName);

    const storedTable = (sqlTableName: string): AnyTable | undefined => {
      const ormName = ormNameOf.get(sqlTableName);
      return ormName === undefined ? undefined : stored.tables[ormName];
    };

    const introspected = yield* introspectSchema({
      provider: config.provider,
      internalTables,
      tableNameMapping: (sqlTableName) => ormNameOf.get(sqlTableName) ?? sqlTableName,
      columnNameMapping: (sqlTableName, sqlColumnName) =>
        storedTable(sqlTableName)?.getColumnBySqlName(sqlColumnName)?.ormName ?? sqlColumnName,
      columnTypeMapping: (dataType, { columnName, isPrimaryKey, metadata, tableName }) => {
        const existing = storedTable(tableName)?.getColumnBySqlName(columnName);
        if (existing !== undefined) {
          // Keep the target's type whenever the raw database type can carry it,
          // so a lossless representation is not reported as a type change.
          for (const candidate of dbToSchemaType(dataType, config.provider, metadata)) {
            if (candidate === existing.type) return candidate;
            if (candidate === "varchar(n)" && existing.type.startsWith("varchar"))
              return existing.type;
          }
        }
        return defaultStorageType(dataType, config.provider, { metadata, isPrimaryKey });
      },
    });

    return generateMigrationFromSchema(introspected, target, {
      provider: config.provider,
      relationMode: config.relationMode,
      dropUnusedColumns,
      dropUnusedTables: false,
    });
  });
