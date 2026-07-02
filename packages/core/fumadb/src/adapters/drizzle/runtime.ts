import { relations, sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import * as sqlite from "drizzle-orm/sqlite-core";
import { createId } from "../../cuid";
import { IdColumn, schema as fumaSchema, type AnyColumn, type AnySchema, type AnyTable } from "../../schema";
import { schemaToDBType } from "../../schema/serialize";
import type { SQLProvider } from "../../shared/providers";

export type DrizzleRuntimeProvider = Extract<SQLProvider, "postgresql" | "sqlite">;

export interface DrizzleRuntimeSchemaOptions {
  readonly schema: AnySchema;
  readonly namespace: string;
  readonly provider: DrizzleRuntimeProvider;
}

export interface DrizzleRuntimeTablesOptions {
  readonly tables: Record<string, AnyTable>;
  readonly namespace: string;
  readonly version: string;
  readonly provider: DrizzleRuntimeProvider;
}

export interface ExecutableDrizzleDb {
  readonly execute?: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
  readonly run?: (query: ReturnType<typeof sql.raw>) => unknown;
  readonly transaction?: <A>(run: (tx: ExecutableDrizzleDb) => Promise<A>) => Promise<A>;
}

const parseVarcharLength = (type: string): number | undefined => {
  const match = /^varchar\((\d+)\)$/.exec(type);
  return match ? Number(match[1]) : undefined;
};

const mapForeignKeyAction = (action: string): "cascade" | "restrict" | "set null" => {
  if (action === "CASCADE") return "cascade";
  if (action === "SET NULL") return "set null";
  return "restrict";
};

const pgBinary = pg.customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  toDriver: (value) => value,
});

const pgColumnBuilder = (column: AnyColumn) => {
  let builder: any =
    column.type === "uuid"
      ? pg.uuid(column.names.sql)
      : column.type === "string"
        ? pg.text(column.names.sql)
        : column.type === "binary"
          ? pgBinary(column.names.sql)
          : column.type === "bool"
            ? pg.boolean(column.names.sql)
            : column.type === "bigint"
              ? pg.bigint(column.names.sql, { mode: "bigint" })
              : column.type === "integer"
                ? pg.integer(column.names.sql)
                : column.type === "decimal"
                  ? pg.numeric(column.names.sql, { mode: "number" })
                  : column.type === "json"
                    ? pg.json(column.names.sql)
                    : column.type === "date"
                      ? pg.date(column.names.sql)
                      : column.type === "timestamp"
                        ? pg.timestamp(column.names.sql)
                        : undefined;

  if (!builder) {
    const length = parseVarcharLength(column.type);
    if (length === undefined) throw new Error(`Unsupported FumaDB column type for Postgres Drizzle: ${column.type}`);
    builder = pg.varchar(column.names.sql, { length });
  }

  return applyColumnModifiers(builder, column, "postgresql");
};

const sqliteColumnBuilder = (column: AnyColumn) => {
  let builder: any =
    column.type === "uuid" || column.type === "string" || column.type.startsWith("varchar(")
      ? sqlite.text(column.names.sql)
      : column.type === "binary"
        ? sqlite.blob(column.names.sql)
        : column.type === "bool"
          ? sqlite.integer(column.names.sql, { mode: "boolean" })
          : column.type === "bigint"
            ? sqlite.blob(column.names.sql, { mode: "bigint" })
            : column.type === "integer"
              ? sqlite.integer(column.names.sql)
              : column.type === "decimal"
                ? sqlite.real(column.names.sql)
                : column.type === "json"
                  ? sqlite.blob(column.names.sql, { mode: "json" })
                  : column.type === "date" || column.type === "timestamp"
                    ? sqlite.integer(column.names.sql, { mode: "timestamp" })
                    : undefined;

  if (!builder) throw new Error(`Unsupported FumaDB column type for SQLite Drizzle: ${column.type}`);
  return applyColumnModifiers(builder, column, "sqlite");
};

const applyColumnModifiers = (builder: any, column: AnyColumn, provider: DrizzleRuntimeProvider) => {
  if (column instanceof IdColumn) builder = builder.primaryKey();
  if (column.isUnique) builder = builder.unique(column.getUniqueConstraintName());
  if (!column.isNullable) builder = builder.notNull();

  if (column.default) {
    if ("value" in column.default) {
      builder = builder.default(column.default.value);
    } else if (column.default.runtime === "auto") {
      builder = builder.$defaultFn(() => createId());
    } else if (column.default.runtime === "now") {
      builder = provider === "sqlite" ? builder.$defaultFn(() => new Date()) : builder.defaultNow();
    } else {
      builder = builder.$defaultFn(column.default.runtime);
    }
  }

  return builder;
};

const makeTable = (
  provider: DrizzleRuntimeProvider,
  table: AnyTable,
  columns: Record<string, unknown>,
  tableMap: Record<string, any>,
) => {
  const constraints = (self: any) => [
    ...table
      .getUniqueConstraints("table")
      .map((constraint) =>
        (provider === "sqlite" ? sqlite.uniqueIndex(constraint.name) : pg.uniqueIndex(constraint.name)).on(
          ...constraint.columns.map((column) => self[column.names.drizzle]),
        ),
      ),
    ...table.foreignKeys.map((key) => {
      const foreignKey = (provider === "sqlite" ? sqlite.foreignKey : pg.foreignKey) as any;
      return foreignKey({
        columns: key.columns.map((column) => self[column.names.drizzle]),
        foreignColumns: key.referencedColumns.map(
          (column) => tableMap[key.referencedTable.names.drizzle][column.names.drizzle],
        ),
        name: key.name,
      })
        .onUpdate(mapForeignKeyAction(key.onUpdate))
        .onDelete(mapForeignKeyAction(key.onDelete));
    }),
  ];

  return provider === "sqlite"
    ? sqlite.sqliteTable(table.names.sql, columns as Record<string, any>, constraints)
    : pg.pgTable(table.names.sql, columns as Record<string, any>, constraints);
};

const settingsTableName = (namespace: string) => `private_${namespace}_settings`;

export const createDrizzleRuntimeSchema = (
  options: DrizzleRuntimeSchemaOptions,
): Record<string, unknown> => {
  const schema: Record<string, unknown> = {};
  const tableMap: Record<string, any> = {};

  for (const table of Object.values(options.schema.tables)) {
    const columns: Record<string, unknown> = {};
    for (const [columnKey, column] of Object.entries(table.columns)) {
      columns[columnKey] =
        options.provider === "sqlite" ? sqliteColumnBuilder(column) : pgColumnBuilder(column);
    }

    const drizzleTable = makeTable(options.provider, table, columns, tableMap);
    schema[table.names.drizzle] = drizzleTable;
    tableMap[table.names.drizzle] = drizzleTable;
  }

  for (const table of Object.values(options.schema.tables)) {
    const relationEntries = Object.values(table.relations);
    if (relationEntries.length === 0) continue;

    schema[`${table.names.drizzle}Relations`] = (relations as any)(
      tableMap[table.names.drizzle],
      ({ one, many }: any) => {
        const out: Record<string, unknown> = {};
        for (const relation of relationEntries) {
          const targetTable = tableMap[relation.table.names.drizzle];
          const relationOptions: any = {
            relationName: relation.id,
          };

          if (!relation.implied || relation.type === "one") {
            relationOptions.fields = relation.on.map(
              ([left]) => tableMap[table.names.drizzle][table.columns[left].names.drizzle],
            );
            relationOptions.references = relation.on.map(
              ([, right]) => targetTable[relation.table.columns[right].names.drizzle],
            );
          }

          out[relation.name] =
            relation.type === "one"
              ? one(targetTable, relationOptions)
              : many(targetTable, relationOptions);
        }
        return out;
      },
    );
  }

  const settings = settingsTableName(options.namespace);
  schema[settings] =
    options.provider === "sqlite"
      ? sqlite.sqliteTable(settings, {
          id: sqlite.text("id").primaryKey().notNull(),
          version: sqlite.text("version").notNull().default(options.schema.version),
        })
      : pg.pgTable(settings, {
          id: pg.varchar("id", { length: 255 }).primaryKey().notNull(),
          version: pg.varchar("version", { length: 255 }).notNull().default(options.schema.version),
        });

  return schema;
};

export const createDrizzleRuntimeSchemaFromTables = (
  options: DrizzleRuntimeTablesOptions,
): Record<string, unknown> =>
  createDrizzleRuntimeSchema({
    schema: fumaSchema({
      version: options.version,
      tables: options.tables,
    }),
    namespace: options.namespace,
    provider: options.provider,
  });

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const defaultSql = (column: AnyColumn, provider: DrizzleRuntimeProvider): string | undefined => {
  if (!column.default) return undefined;
  if ("runtime" in column.default) return undefined;

  const value = column.default.value;
  if (value === null) return "NULL";
  if (typeof value === "boolean") return provider === "sqlite" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return provider === "sqlite" ? String(value.getTime()) : quoteLiteral(value.toISOString());
  if (column.type === "json") {
    const encoded = quoteLiteral(JSON.stringify(value));
    return provider === "sqlite" ? encoded : `${encoded}::json`;
  }
  if (value instanceof Uint8Array) {
    const hex = bytesToHex(value);
    return provider === "sqlite" ? `x'${hex}'` : `decode(${quoteLiteral(hex)}, 'hex')`;
  }
  return quoteLiteral(String(value));
};

const columnDefinitionSql = (column: AnyColumn, provider: DrizzleRuntimeProvider): string => {
  const parts = [quoteIdent(column.names.sql), schemaToDBType(column, provider)];
  if (column instanceof IdColumn) parts.push("PRIMARY KEY");
  if (!column.isNullable) parts.push("NOT NULL");
  const defaultValue = defaultSql(column, provider);
  if (defaultValue) parts.push("DEFAULT", defaultValue);
  return parts.join(" ");
};

const createTableSql = (table: AnyTable, provider: DrizzleRuntimeProvider): string => {
  const constraints = table.foreignKeys.map((key) => {
    const columns = key.columns.map((column) => quoteIdent(column.names.sql)).join(", ");
    const referencedColumns = key.referencedColumns
      .map((column) => quoteIdent(column.names.sql))
      .join(", ");
    return [
      "CONSTRAINT",
      quoteIdent(key.name),
      "FOREIGN KEY",
      `(${columns})`,
      "REFERENCES",
      quoteIdent(key.referencedTable.names.sql),
      `(${referencedColumns})`,
      "ON UPDATE",
      key.onUpdate,
      "ON DELETE",
      key.onDelete,
    ].join(" ");
  });

  return [
    "CREATE TABLE IF NOT EXISTS",
    quoteIdent(table.names.sql),
    `(${[...Object.values(table.columns).map((column) => columnDefinitionSql(column, provider)), ...constraints].join(", ")})`,
  ].join(" ");
};

const createUniqueIndexSql = (
  table: AnyTable,
  constraint: { name: string; columns: AnyColumn[] },
) =>
  [
    "CREATE UNIQUE INDEX IF NOT EXISTS",
    quoteIdent(constraint.name),
    "ON",
    quoteIdent(table.names.sql),
    `(${constraint.columns.map((column) => quoteIdent(column.names.sql)).join(", ")})`,
  ].join(" ");

const createSettingsTableSql = (
  namespace: string,
  version: string,
  provider: DrizzleRuntimeProvider,
) =>
  [
    "CREATE TABLE IF NOT EXISTS",
    quoteIdent(settingsTableName(namespace)),
    `(${quoteIdent("id")} ${provider === "sqlite" ? "text" : "varchar(255)"} PRIMARY KEY NOT NULL, ${quoteIdent("version")} ${provider === "sqlite" ? "text" : "varchar(255)"} NOT NULL DEFAULT ${quoteLiteral(version)})`,
  ].join(" ");

export const createDrizzleRuntimeSchemaSql = (
  options: DrizzleRuntimeSchemaOptions,
): readonly string[] => [
  ...Object.values(options.schema.tables).map((table) => createTableSql(table, options.provider)),
  ...Object.values(options.schema.tables).flatMap((table) =>
    table.getUniqueConstraints().map((constraint) => createUniqueIndexSql(table, constraint)),
  ),
  createSettingsTableSql(options.namespace, options.schema.version, options.provider),
];

/** `ALTER TABLE … ADD COLUMN` statements for every NULLABLE column, one per
 *  column. `CREATE TABLE IF NOT EXISTS` never touches an existing table, so a
 *  schema-evolution column would otherwise only exist in fresh databases. Each
 *  statement fails with a duplicate-column error when the column already
 *  exists — callers run them individually and swallow exactly that error,
 *  which keeps this idempotent without provider-specific catalog probes.
 *  Non-nullable additions can't be backfilled blindly and still need a real
 *  migration. */
const addNullableColumnsSql = (options: DrizzleRuntimeSchemaOptions): readonly string[] =>
  Object.values(options.schema.tables).flatMap((table) =>
    Object.values(table.columns)
      .filter((column) => column.isNullable && !(column instanceof IdColumn))
      .map((column) =>
        [
          "ALTER TABLE",
          quoteIdent(table.names.sql),
          "ADD COLUMN",
          columnDefinitionSql(column, options.provider),
        ].join(" "),
      ),
  );

const isDuplicateColumnError = (error: unknown): boolean => {
  // Drivers wrap the SQL error (e.g. DrizzleQueryError → LibsqlError), so
  // match anywhere down the cause chain.
  for (let current = error, depth = 0; current != null && depth < 8; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/duplicate column|already exists/i.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
};

export const createDrizzleRuntimeSchemaSqlFromTables = (
  options: DrizzleRuntimeTablesOptions,
): readonly string[] =>
  createDrizzleRuntimeSchemaSql({
    schema: fumaSchema({
      version: options.version,
      tables: options.tables,
    }),
    namespace: options.namespace,
    provider: options.provider,
  });

const runStatement = async (db: ExecutableDrizzleDb, statement: string): Promise<void> => {
  if (db.execute) {
    await db.execute(sql.raw(statement));
    return;
  }
  if (db.run) {
    await db.run(sql.raw(statement));
    return;
  }
  throw new Error("Drizzle database cannot execute raw schema statements");
};

export const ensureDrizzleRuntimeSchema = async (
  db: ExecutableDrizzleDb,
  options: DrizzleRuntimeSchemaOptions,
): Promise<void> => {
  const statements = createDrizzleRuntimeSchemaSql(options);
  const run = async (target: ExecutableDrizzleDb) => {
    for (const statement of statements) {
      await runStatement(target, statement);
    }
  };

  if (db.transaction) {
    await db.transaction(run);
  } else {
    await run(db);
  }

  // Evolve existing tables: add any nullable columns they predate. Outside
  // the transaction — each statement individually either succeeds (column was
  // missing) or fails with a duplicate-column error (column exists, ignored).
  for (const statement of addNullableColumnsSql(options)) {
    try {
      await runStatement(db, statement);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
};

export const ensureDrizzleRuntimeSchemaFromTables = async (
  db: ExecutableDrizzleDb,
  options: DrizzleRuntimeTablesOptions,
): Promise<void> =>
  ensureDrizzleRuntimeSchema(db, {
    schema: fumaSchema({
      version: options.version,
      tables: options.tables,
    }),
    namespace: options.namespace,
    provider: options.provider,
  });
