/**
 * DDL rendering: turn provider-independent {@link MigrationOperation}s into SQL
 * text for one provider.
 *
 * Migration statements are rendered as literal SQL text, not as parameterised
 * statements, so a migration can be exported and run as a standalone script
 * (`MigrationResult.sql`). Identifiers are quoted here and string literals are
 * escaped here; no value from a query ever reaches this module.
 *
 * The text is byte-compatible with the SQL upstream fumadb produced through
 * Kysely, which the snapshots in `test/snapshots/upstream/migration` pin.
 * Combinations no snapshot pins and that upstream rendered as invalid SQL are
 * corrected here instead: a `bool`, `date`, or `timestamp` constant default is
 * written in the representation the provider stores, and MSSQL gets
 * `sp_rename` for a column rename. One pinned combination is corrected as
 * well: an MSSQL `alter column` always restates the nullability, because
 * T-SQL makes the column nullable when it is left out.
 */
import { Option, Result } from "effect";
import { MigrationError } from "../../contracts/errors.ts";
import {
  type ColumnOperation,
  type ForeignKeyInfo,
  isColumnUpdated,
  type MigrationOperation,
} from "../../contracts/migration-operation.ts";
import type { Provider } from "../../contracts/provider.ts";
import { schemaToDbType, supportsLiteralDefault } from "../schema-codec.ts";
import { type AnyColumn, isIdColumn } from "../../contracts/schema/column.ts";
import { compileForeignKey, type ForeignKeyAction } from "../../contracts/schema/relation.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";
import type { ResolvedSqlAdapterConfig } from "../../contracts/sql.ts";

/**
 * Quote an identifier for a provider. MySQL uses backticks, every other
 * provider uses double quotes; the quote character is doubled to escape it.
 */
export const quoteIdentifier = (name: string, provider: Provider): string =>
  provider === "mysql" ? `\`${name.replaceAll("`", "``")}\`` : `"${name.replaceAll('"', '""')}"`;

/**
 * Quote a string as a SQL literal. Single quotes are doubled; MySQL also
 * escapes backslashes, which it treats as escape characters by default.
 */
export const quoteStringLiteral = (value: string, provider: Provider): string =>
  provider === "mysql"
    ? `'${value.replace(/[\\']/g, (char) => (char === "\\" ? "\\\\" : "''"))}'`
    : `'${value.replaceAll("'", "''")}'`;

const pad = (value: number, length: number = 2): string => String(value).padStart(length, "0");

/** `YYYY-MM-DD`, in UTC, like the value the codec reads back. */
const dateText = (value: Date): string =>
  `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;

/** `YYYY-MM-DD HH:MM:SS[.mmm]`, in UTC. */
const timestampText = (value: Date, fractional: boolean): string => {
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  const fraction = fractional ? `.${pad(value.getUTCMilliseconds(), 3)}` : "";
  return `${dateText(value)} ${time}${fraction}`;
};

/**
 * A `date` or `timestamp` constant, in the representation the provider stores
 * (`schema/codec.ts`): epoch milliseconds on SQLite, a quoted UTC date or
 * date-time everywhere else.
 */
const temporalLiteral = (value: Date, type: "date" | "timestamp", provider: Provider): string => {
  // A `date` keeps only the UTC calendar day on every provider (see `toDriver`).
  const stored =
    type === "date"
      ? new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
      : value;
  if (provider === "sqlite") return String(stored.getTime());
  if (type === "date") return quoteStringLiteral(dateText(stored), provider);
  return quoteStringLiteral(timestampText(stored, true), provider);
};

/**
 * Render a constant column default as a SQL literal.
 *
 * The literal is written in the representation `schema/codec.ts` gives the
 * column on that provider, so a row created by the database default decodes
 * the same way as a row written through the ORM. A value that has no literal
 * form fails with reason `"Unsupported"`.
 */
const literal = (
  value: unknown,
  column: AnyColumn,
  provider: Provider,
): Result.Result<string, MigrationError> => {
  switch (column.type) {
    case "bool":
      if (typeof value === "boolean") {
        // `bit` on MSSQL and an integer column on SQLite: neither has a boolean literal.
        return Result.succeed(
          provider === "mssql" || provider === "sqlite" ? (value ? "1" : "0") : String(value),
        );
      }
      break;
    case "date":
    case "timestamp":
      if (value instanceof Date)
        return Result.succeed(temporalLiteral(value, column.type, provider));
      break;
    case "json": {
      // Stored as JSON text on every provider, like `serialize`.
      const text = JSON.stringify(value);
      if (text !== undefined) return Result.succeed(quoteStringLiteral(text, provider));
      break;
    }
    case "bigint":
      // SQLite keeps bigints as an 8-byte big-endian blob (see `toDriver`), so the
      // default must be the same blob or a row created by it decodes wrongly.
      if (provider === "sqlite" && (typeof value === "bigint" || typeof value === "number")) {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, BigInt(value));
        return Result.succeed(
          `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`,
        );
      }
      break;
    default:
      break;
  }
  if (typeof value === "string") return Result.succeed(quoteStringLiteral(value, provider));
  if (typeof value === "number" || typeof value === "bigint") return Result.succeed(String(value));
  if (value === null) return Result.succeed("null");
  return Result.fail(
    new MigrationError({
      reason: "Unsupported",
      message: `A default value of this kind cannot be written as a SQL literal: ${String(value)}`,
    }),
  );
};

/**
 * `CURRENT_TIMESTAMP` for a `"now"` runtime default, or `None` where the
 * provider cannot express it for that column.
 *
 * SQLite keeps `date` and `timestamp` columns as epoch milliseconds, and MySQL
 * accepts `CURRENT_TIMESTAMP` only on `timestamp` and `datetime` columns. A
 * runtime default is generated by FumaDB on every insert, so dropping the
 * database-level default there keeps behaviour the same.
 */
const currentTimestamp = (column: AnyColumn, provider: Provider): Option.Option<string> => {
  if (provider === "sqlite") return Option.none();
  if (provider === "mysql" && column.type === "date") return Option.none();
  // MySQL requires the default's fractional precision to match the `datetime(3)` column.
  return Option.some(provider === "mysql" ? "CURRENT_TIMESTAMP(3)" : "CURRENT_TIMESTAMP");
};

/**
 * The `DEFAULT` expression for a column, or `None` when the column has no
 * database-level default.
 *
 * Runtime defaults other than `"now"` are generated by FumaDB on insert and
 * never reach the database. A column whose provider cannot store a literal
 * default at all ({@link supportsLiteralDefault}) gets none; the schema diff
 * reads the same predicate, so it does not report a change there either.
 */
const defaultExpression = (
  column: AnyColumn,
  provider: Provider,
): Result.Result<Option.Option<string>, MigrationError> => {
  const value = column.defaultValue;
  if (value === undefined) return Result.succeed(Option.none());
  if (!supportsLiteralDefault(column, provider)) return Result.succeed(Option.none());
  if (value._tag === "Runtime") {
    return Result.succeed(
      value.kind === "now" ? currentTimestamp(column, provider) : Option.none(),
    );
  }
  return Result.map(literal(value.encoded, column, provider), Option.some);
};

/** `"name" type [default x] [not null] [primary key]`, in Kysely's fixed order. */
const columnDefinition = (
  column: AnyColumn,
  provider: Provider,
): Result.Result<string, MigrationError> =>
  Result.map(defaultExpression(column, provider), (def) => {
    let out = `${quoteIdentifier(column.names.sql, provider)} ${schemaToDbType(column, provider)}`;
    if (Option.isSome(def)) out += ` default ${def.value}`;
    if (!column.isNullable) out += " not null";
    if (isIdColumn(column)) out += " primary key";
    return out;
  });

/** MSSQL has no `restrict` referential action; `no action` is its equivalent. */
const foreignKeyAction = (action: ForeignKeyAction, provider: Provider): string => {
  switch (action) {
    case "CASCADE":
      return "cascade";
    case "RESTRICT":
      return provider === "mssql" ? "no action" : "restrict";
    case "SET NULL":
      return "set null";
  }
};

const columnList = (columns: ReadonlyArray<string>, provider: Provider): string =>
  columns.map((column) => quoteIdentifier(column, provider)).join(", ");

const foreignKeyConstraint = (key: ForeignKeyInfo, provider: Provider): string =>
  `constraint ${quoteIdentifier(key.name, provider)} foreign key (${columnList(key.columns, provider)}) references ${quoteIdentifier(
    key.referencedTable,
    provider,
  )} (${columnList(key.referencedColumns, provider)}) on delete ${foreignKeyAction(key.onDelete, provider)} on update ${foreignKeyAction(
    key.onUpdate,
    provider,
  )}`;

/**
 * A unique index. On MSSQL it is filtered so `NULL` values stay duplicable,
 * matching the behaviour of a unique constraint on every other provider.
 */
const createUniqueIndex = (
  name: string,
  table: string,
  columns: ReadonlyArray<string>,
  provider: Provider,
): string => {
  let out = `create unique index ${quoteIdentifier(name, provider)} on ${quoteIdentifier(table, provider)} (${columnList(
    columns,
    provider,
  )})`;
  if (provider !== "mssql") return out;
  const conditions = columns.map((column) => `${quoteIdentifier(column, provider)} is not null`);
  out +=
    conditions.length > 1
      ? ` where (${conditions.join(" and ")})`
      : ` where ${conditions.join(" and ")}`;
  return out;
};

/** SQLite and MSSQL have no `add unique constraint`; they get a unique index. */
const addUniqueConstraint = (
  name: string,
  table: string,
  columns: ReadonlyArray<string>,
  provider: Provider,
): string =>
  provider === "sqlite" || provider === "mssql"
    ? createUniqueIndex(name, table, columns, provider)
    : `alter table ${quoteIdentifier(table, provider)} add constraint ${quoteIdentifier(name, provider)} unique (${columnList(
        columns,
        provider,
      )})`;

const dropUniqueConstraint = (name: string, table: string, provider: Provider): string => {
  switch (provider) {
    case "cockroachdb":
      // CockroachDB backs a unique constraint with an index that other objects may depend on.
      return `drop index if exists ${quoteIdentifier(name, provider)} cascade`;
    case "sqlite":
      return `drop index if exists ${quoteIdentifier(name, provider)}`;
    case "mssql":
      return `drop index if exists ${quoteIdentifier(name, provider)} on ${quoteIdentifier(table, provider)}`;
    default:
      return `alter table ${quoteIdentifier(table, provider)} drop constraint ${quoteIdentifier(name, provider)}`;
  }
};

/**
 * MSSQL names default constraints implicitly, so a column's default must be
 * looked up by hand before the column can be altered or the default replaced.
 */
const dropMssqlDefaultConstraint = (table: string, column: string): string => {
  const alter = quoteStringLiteral(`ALTER TABLE "dbo"."${table}" DROP CONSTRAINT `, "mssql");
  return `DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = ${quoteStringLiteral(table, "mssql")} AND c.name = ${quoteStringLiteral(
    column,
    "mssql",
  )};

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC(${alter} + @ConstraintName);
END`;
};

const unsupported = (message: string): Result.Result<never, MigrationError> =>
  Result.fail(new MigrationError({ reason: "Unsupported", message }));

const errors = {
  idColumnUpdate:
    "ID columns must not be updated, not every database supports updating primary keys and often requires workarounds.",
  sqliteForeignKeys:
    "In SQLite, you cannot modify foreign keys directly, recreate the table instead.",
  sqliteUpdateColumn: "SQLite doesn't support updating a column, recreate the table instead.",
} as const;

/** Statements for one column operation inside `alter table <table>`. */
const columnStatements = (
  table: string,
  operation: ColumnOperation,
  config: ResolvedSqlAdapterConfig,
): Result.Result<ReadonlyArray<string>, MigrationError> => {
  const { provider } = config;
  const alter = `alter table ${quoteIdentifier(table, provider)}`;

  switch (operation.type) {
    case "rename-column":
      return Result.succeed([
        provider === "mssql"
          ? // SQL Server has no `alter table ... rename column`; `sp_rename` takes
            // the qualified old name and the bare new name as string values.
            `EXEC sp_rename ${quoteStringLiteral(`${table}.${operation.from}`, provider)}, ${quoteStringLiteral(
              operation.to,
              provider,
            )}, 'COLUMN'`
          : `${alter} rename column ${quoteIdentifier(operation.from, provider)} to ${quoteIdentifier(
              operation.to,
              provider,
            )}`,
      ]);
    case "drop-column": {
      const drop = `${alter} drop column ${quoteIdentifier(operation.name, provider)}`;
      // SQL Server refuses to drop a column that a default constraint still
      // references, and it names that constraint implicitly (`DF__accounts__email__3D5E1FD2`),
      // so the constraint has to be looked up and dropped first. The lookup is
      // a no-op when the column has no default. Upstream emitted a bare
      // `dropColumn`, so rolling a schema back over a defaulted column failed;
      // the mssql snapshots under test/snapshots record the deviation.
      return Result.succeed(
        provider === "mssql" ? [dropMssqlDefaultConstraint(table, operation.name), drop] : [drop],
      );
    }
    case "create-column":
      return Result.map(columnDefinition(operation.value, provider), (definition) =>
        // MSSQL spells `add column` as `add`.
        [provider === "mssql" ? `${alter} add ${definition}` : `${alter} add column ${definition}`],
      );
    case "update-column": {
      const column = operation.value;
      if (isIdColumn(column)) return unsupported(errors.idColumnUpdate);
      if (provider === "sqlite") return unsupported(errors.sqliteUpdateColumn);
      if (!isColumnUpdated(operation)) return Result.succeed([]);

      const name = quoteIdentifier(operation.name, provider);
      const dbType = schemaToDbType(column, provider);

      if (provider === "mysql") {
        return Result.map(columnDefinition(column, provider), (definition) => [
          `${alter} modify column ${definition}`,
        ]);
      }

      return Result.map(defaultExpression(column, provider), (def) => {
        const statements: Array<string> = [];
        // MSSQL cannot alter a column while a default constraint references it.
        const recreateDefault =
          provider === "mssql" && (operation.updateDataType || operation.updateDefault);
        if (recreateDefault) statements.push(dropMssqlDefaultConstraint(table, column.names.sql));

        if (provider === "mssql") {
          // T-SQL restates the whole column on `alter column`, and it resets
          // the column to NULLable whenever the nullability is left out. A
          // type change alone would therefore silently drop `NOT NULL`, so the
          // nullability is always restated (upstream omitted it and lost the
          // constraint; docs/DESIGN.md records the deviation).
          if (operation.updateDataType || operation.updateNullable) {
            statements.push(
              `${alter} alter column ${name} ${dbType}${column.isNullable ? " null" : " not null"}`,
            );
          }
        } else {
          if (operation.updateDataType) {
            statements.push(
              `ALTER TABLE ${quoteIdentifier(table, provider)} ALTER COLUMN ${name} TYPE ${dbType} USING (${name}::${dbType})`,
            );
          }
          if (operation.updateNullable) {
            statements.push(
              `${alter} alter column ${name} ${column.isNullable ? "drop not null" : "set not null"}`,
            );
          }
        }
        if (recreateDefault) {
          if (Option.isSome(def)) {
            const constraint = quoteIdentifier(`DF_${table}_${column.names.sql}`, provider);
            statements.push(
              `ALTER TABLE ${quoteIdentifier(table, provider)} ADD CONSTRAINT ${constraint} DEFAULT ${def.value} FOR ${name}`,
            );
          }
        } else if (provider !== "mssql" && operation.updateDefault) {
          statements.push(
            `${alter} alter column ${name} ${Option.isSome(def) ? `set default ${def.value}` : "drop default"}`,
          );
        }
        return statements;
      });
    }
  }
};

const createTableStatements = (
  table: AnyTable,
  options: { readonly skipForeignKeys: boolean; readonly skipUniqueIndexes: boolean },
  config: ResolvedSqlAdapterConfig,
): Result.Result<ReadonlyArray<string>, MigrationError> => {
  const { provider, relationMode } = config;
  const name = table.names.sql;
  const columns = Object.values(table.columns);
  return Result.map(
    Result.all(columns.map((column) => columnDefinition(column, provider))),
    (definitions) => {
      const parts: Array<string> = [...definitions];
      if (!options.skipForeignKeys && relationMode !== "fumadb") {
        for (const key of table.foreignKeys)
          parts.push(foreignKeyConstraint(compileForeignKey(key), provider));
      }
      const statements: Array<string> = [
        `create table ${quoteIdentifier(name, provider)} (${parts.join(", ")})`,
      ];
      if (!options.skipUniqueIndexes) {
        for (const constraint of table.getUniqueConstraints()) {
          statements.push(
            addUniqueConstraint(
              constraint.name,
              name,
              constraint.columns.map((column) => column.names.sql),
              provider,
            ),
          );
        }
      }
      return statements;
    },
  );
};

/**
 * Render one migration operation as the SQL statements that perform it.
 *
 * Fails with a `MigrationError` of reason `"Unsupported"` when the provider
 * cannot express the operation: updating a column or changing a foreign key on
 * SQLite (the SQLite transformer rewrites those into a table recreate), and
 * updating an id column on any provider.
 */
export const renderOperation = (
  operation: MigrationOperation,
  config: ResolvedSqlAdapterConfig,
): Result.Result<ReadonlyArray<string>, MigrationError> => {
  const { provider } = config;
  switch (operation.type) {
    case "create-table":
      return createTableStatements(
        operation.value,
        {
          skipForeignKeys: operation.skipForeignKeys === true,
          skipUniqueIndexes: operation.skipUniqueIndexes === true,
        },
        config,
      );
    case "rename-table":
      return Result.succeed([
        provider === "mssql"
          ? // sp_rename takes names, not identifiers; quoting them renames to a quoted name.
            `EXEC sp_rename ${operation.from}, ${operation.to}`
          : `alter table ${quoteIdentifier(operation.from, provider)} rename to ${quoteIdentifier(
              operation.to,
              provider,
            )}`,
      ]);
    case "update-table":
      return Result.map(
        Result.all(
          operation.value.map((column) => columnStatements(operation.name, column, config)),
        ),
        (lists) => lists.flat(),
      );
    case "drop-table":
      return Result.succeed([`drop table ${quoteIdentifier(operation.name, provider)}`]);
    case "custom":
      return Result.succeed([operation.sql]);
    case "add-foreign-key": {
      if (provider === "sqlite") return unsupported(errors.sqliteForeignKeys);
      return Result.succeed([
        `alter table ${quoteIdentifier(operation.table, provider)} add ${foreignKeyConstraint(
          operation.value,
          provider,
        )}`,
      ]);
    }
    case "drop-foreign-key": {
      if (provider === "sqlite") return unsupported(errors.sqliteForeignKeys);
      // MySQL has no `drop constraint if exists`.
      const ifExists = provider === "mysql" ? "" : "if exists ";
      return Result.succeed([
        `alter table ${quoteIdentifier(operation.table, provider)} drop constraint ${ifExists}${quoteIdentifier(
          operation.name,
          provider,
        )}`,
      ]);
    }
    case "add-unique-constraint":
      return Result.succeed([
        addUniqueConstraint(operation.name, operation.table, operation.columns, provider),
      ]);
    case "drop-unique-constraint":
      return Result.succeed([dropUniqueConstraint(operation.name, operation.table, provider)]);
  }
};

/** Render every operation, in order, as a flat list of SQL statements. */
export const renderStatements = (
  operations: ReadonlyArray<MigrationOperation>,
  config: ResolvedSqlAdapterConfig,
): Result.Result<ReadonlyArray<string>, MigrationError> =>
  Result.map(
    Result.all(operations.map((operation) => renderOperation(operation, config))),
    (lists) => lists.flat(),
  );

/**
 * Render every operation as one runnable script: each statement is terminated
 * with `;` and statements are separated by a blank line.
 */
export const renderScript = (
  operations: ReadonlyArray<MigrationOperation>,
  config: ResolvedSqlAdapterConfig,
): Result.Result<string, MigrationError> =>
  Result.map(renderStatements(operations, config), (statements) =>
    statements.map((statement) => `${statement};`).join("\n\n"),
  );
