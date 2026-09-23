/**
 * Generate migration operations by diffing two schemas.
 *
 * This is the `from-schema` mode. The same function serves `from-database`
 * mode with an introspected schema as `old`.
 */
import { Equal } from "effect";
import type { Provider, RelationMode } from "../../contracts/provider.ts";
import { defaultRelationMode } from "../../contracts/provider.ts";
import { supportsLiteralDefault } from "../schema-codec.ts";
import type { AnyColumn } from "../../contracts/schema/column.ts";
import { compileForeignKey } from "../../contracts/schema/relation.ts";
import type { AnySchema } from "../../contracts/schema/schema.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";
import {
  type ColumnOperation,
  isColumnUpdated,
  type MigrationOperation,
} from "../../contracts/migration-operation.ts";

/** Options of {@link generateMigrationFromSchema}. */
export interface GenerateMigrationOptions {
  readonly provider: Provider;
  readonly relationMode?: RelationMode;
  /**
   * Drop tables that no longer exist in the target schema. Only tables known to
   * the source schema are affected. Destructive, so it defaults to `false`.
   */
  readonly dropUnusedTables?: boolean;
  /**
   * Drop columns that no longer exist in the target schema. Destructive, so it
   * defaults to `false`. When it is `false`, a kept column that is required and
   * has no default is made nullable instead, so the table stays writable.
   */
  readonly dropUnusedColumns?: boolean;
}

type Operation = MigrationOperation & { readonly enforce?: "pre" | "post" };

const ORDER = { pre: -1, default: 0, post: 1 } as const;

const sameStrings = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Default values are compared structurally. Runtime defaults never reach the
 * database, and a default the provider cannot store as a literal
 * ({@link supportsLiteralDefault}) is never in the database either, so it must
 * not show up as a change. The DDL generator reads the same predicate.
 */
const hashDefault = (col: AnyColumn, provider: Provider): unknown => {
  if (col.defaultValue === undefined || col.defaultValue._tag === "Runtime") return undefined;
  if (!supportsLiteralDefault(col, provider)) return undefined;
  return col.defaultValue.encoded;
};

/**
 * The operations that turn the database described by `old` into `target`.
 *
 * Operations are ordered so they can run in sequence: renames and removed
 * foreign keys first, then column and constraint changes, then drops.
 */
export const generateMigrationFromSchema = (
  old: AnySchema,
  target: AnySchema,
  options: GenerateMigrationOptions,
): ReadonlyArray<MigrationOperation> => {
  const {
    dropUnusedColumns = false,
    dropUnusedTables = false,
    provider,
    relationMode = defaultRelationMode(provider),
  } = options;

  const columnActionsToOperations = (
    tableName: string,
    actions: ReadonlyArray<ColumnOperation>,
  ): ReadonlyArray<Operation> => {
    if (actions.length === 0) return [];
    switch (provider) {
      case "mysql":
      case "postgresql":
      case "cockroachdb":
        return [{ type: "update-table", name: tableName, value: actions }];
      case "sqlite":
      case "mssql":
        return actions.map((action) => ({
          type: "update-table",
          name: tableName,
          value: [action],
        }));
    }
  };

  const uniqueConstraintCheck = (prev: AnyTable, next: AnyTable): ReadonlyArray<Operation> => {
    const operations: Array<Operation> = [];
    const newConstraints = next.getUniqueConstraints();
    const oldConstraints = prev.getUniqueConstraints();
    for (const con of newConstraints) {
      const oldCon = oldConstraints.find((item) => item.name === con.name);
      const columns = con.columns.map((col) => col.names.sql);
      if (oldCon === undefined) {
        operations.push({
          type: "add-unique-constraint",
          name: con.name,
          table: next.names.sql,
          columns,
        });
        continue;
      }
      if (
        sameStrings(
          columns,
          oldCon.columns.map((col) => col.names.sql),
        )
      )
        continue;
      operations.push(
        { type: "drop-unique-constraint", table: next.names.sql, name: con.name },
        { type: "add-unique-constraint", table: next.names.sql, name: con.name, columns },
      );
    }
    for (const con of oldConstraints) {
      if (newConstraints.every((item) => item.name !== con.name)) {
        operations.push({ type: "drop-unique-constraint", table: next.names.sql, name: con.name });
      }
    }
    return operations;
  };

  const tableRenameCheck = (oldTable: AnyTable, newTable: AnyTable): ReadonlyArray<Operation> =>
    newTable.names.sql !== oldTable.names.sql
      ? [{ type: "rename-table", from: oldTable.names.sql, to: newTable.names.sql, enforce: "pre" }]
      : [];

  const columnsCheck = (oldTable: AnyTable, newTable: AnyTable): ReadonlyArray<Operation> => {
    const actions: Array<ColumnOperation> = [];
    for (const column of Object.values(newTable.columns)) {
      const oldColumn = oldTable.columns[column.ormName];
      if (oldColumn === undefined) {
        actions.push({ type: "create-column", value: column });
        continue;
      }
      if (column.names.sql !== oldColumn.names.sql) {
        actions.push({ type: "rename-column", from: oldColumn.names.sql, to: column.names.sql });
      }
      const action: ColumnOperation = {
        type: "update-column",
        name: column.names.sql,
        updateDataType: column.type !== oldColumn.type,
        updateDefault: !Equal.equals(
          hashDefault(column, provider),
          hashDefault(oldColumn, provider),
        ),
        updateNullable: column.isNullable !== oldColumn.isNullable,
        value: column,
      };
      if (isColumnUpdated(action)) actions.push(action);
    }
    return columnActionsToOperations(newTable.names.sql, actions);
  };

  const foreignKeyCheck = (oldTable: AnyTable, newTable: AnyTable): ReadonlyArray<Operation> => {
    if (relationMode === "fumadb") return [];
    const tableName = newTable.names.sql;
    const operations: Array<Operation> = [];
    for (const key of newTable.foreignKeys) {
      const compiled = compileForeignKey(key);
      const oldKey = oldTable.foreignKeys.find((k) => k.name === key.name);
      if (oldKey === undefined) {
        operations.push({
          type: "add-foreign-key",
          table: tableName,
          value: compiled,
          enforce: "post",
        });
        continue;
      }
      if (!Equal.equals(compiled, compileForeignKey(oldKey))) {
        operations.push(
          { type: "drop-foreign-key", name: oldKey.name, table: tableName, enforce: "post" },
          { type: "add-foreign-key", table: tableName, value: compiled, enforce: "post" },
        );
      }
    }
    return operations;
  };

  const unusedForeignKeyCheck = (
    oldTable: AnyTable,
    newTable: AnyTable,
  ): ReadonlyArray<Operation> => {
    const operations: Array<Operation> = [];
    for (const oldKey of oldTable.foreignKeys) {
      if (newTable.foreignKeys.some((k) => k.name === oldKey.name)) continue;
      operations.push({
        type: "drop-foreign-key",
        name: oldKey.name,
        table: oldTable.names.sql,
        enforce: "pre",
      });
    }
    return operations;
  };

  const unusedColumnsCheck = (oldTable: AnyTable, newTable: AnyTable): ReadonlyArray<Operation> => {
    const constraints = newTable.getUniqueConstraints();
    const operations: Array<Operation> = [];
    for (const oldColumn of Object.values(oldTable.columns)) {
      if (newTable.columns[oldColumn.ormName] !== undefined) continue;
      if (!dropUnusedColumns) {
        // A kept column that is required and has no default would make every
        // insert fail, so it is made nullable. Nothing is dropped.
        if (oldColumn.isNullable || oldColumn.defaultValue !== undefined) continue;
        operations.push({
          type: "update-table",
          name: newTable.names.sql,
          value: [
            {
              type: "update-column",
              name: oldColumn.names.sql,
              value: oldColumn.clone({ nullable: true }),
              updateDataType: false,
              updateDefault: false,
              updateNullable: true,
            },
          ],
          enforce: "post",
        });
        continue;
      }
      // MSSQL does not drop unique indexes together with the column.
      if (provider === "mssql" && oldColumn.isUnique) {
        for (const con of constraints) {
          if (con.columns.every((col) => col.ormName !== oldColumn.ormName)) continue;
          operations.push({
            type: "drop-unique-constraint",
            name: con.name,
            table: newTable.names.sql,
          });
        }
      }
      operations.push({
        type: "update-table",
        name: newTable.names.sql,
        value: [{ type: "drop-column", name: oldColumn.names.sql }],
        enforce: "post",
      });
    }
    return operations;
  };

  const operations: Array<Operation> = [];
  for (const table of Object.values(target.tables)) {
    const oldTable = old.tables[table.ormName];
    if (oldTable === undefined) {
      // CockroachDB cannot add a foreign key in `CREATE TABLE` when the
      // referenced table is created in the same transaction.
      if (provider === "cockroachdb" && relationMode !== "fumadb") {
        operations.push({ type: "create-table", value: table, skipForeignKeys: true });
        for (const key of table.foreignKeys) {
          operations.push({
            type: "add-foreign-key",
            enforce: "post",
            table: table.names.sql,
            value: compileForeignKey(key),
          });
        }
      } else {
        operations.push({ type: "create-table", value: table });
      }
      continue;
    }
    operations.push(
      ...unusedForeignKeyCheck(oldTable, table),
      ...tableRenameCheck(oldTable, table),
      ...columnsCheck(oldTable, table),
      ...uniqueConstraintCheck(oldTable, table),
      ...foreignKeyCheck(oldTable, table),
      ...unusedColumnsCheck(oldTable, table),
    );
  }
  for (const oldTable of Object.values(old.tables)) {
    if (target.tables[oldTable.ormName] === undefined && dropUnusedTables) {
      operations.push({ type: "drop-table", name: oldTable.names.sql, enforce: "post" });
    }
  }
  // Stable sort keeps the relative order within each phase.
  return operations
    .map((op, index) => ({ op, index }))
    .sort(
      (a, b) =>
        ORDER[a.op.enforce ?? "default"] - ORDER[b.op.enforce ?? "default"] || a.index - b.index,
    )
    .map(({ op }) => {
      const { enforce: _enforce, ...rest } = op;
      return rest as MigrationOperation;
    });
};
