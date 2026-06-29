import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  compileForeignKey,
  type NameVariants,
} from "../schema/create";
import type { RelationMode } from "../shared/config";
import type { Provider } from "../shared/providers";
import { deepEqual } from "../utils/deep-equal";
import {
  type ColumnOperation,
  isUpdated,
  type MigrationOperation,
} from "./shared";

type Operation = MigrationOperation & { enforce?: "pre" | "post" };

/**
 * Generate migration by comparing two schemas
 */
export function generateMigrationFromSchema(
  old: AnySchema,
  schema: AnySchema,
  options: {
    provider: Provider;
    relationMode?: RelationMode;

    /**
     * Drop tables if no longer exist in latest schema.
     *
     * This only detects tables from schema, user tables won't be affected.
     */
    dropUnusedTables?: boolean;
    dropUnusedColumns?: boolean;
  }
): MigrationOperation[] {
  const {
    provider,
    relationMode = provider === "mssql" || provider === "mongodb"
      ? "@executor-js/fumadb"
      : "foreign-keys",
    dropUnusedTables = true,
    dropUnusedColumns = true,
  } = options;

  function getName(names: NameVariants) {
    return provider === "mongodb" ? names.mongodb : names.sql;
  }

  function columnActionToOperation(
    tableName: string,
    actions: ColumnOperation[]
  ): MigrationOperation[] {
    if (actions.length === 0) return [];

    if (
      provider === "mysql" ||
      provider === "postgresql" ||
      provider === "mongodb"
    ) {
      return [
        {
          type: "update-table",
          name: tableName,
          value: actions,
        },
      ];
    }

    return actions.map((action) => ({
      type: "update-table",
      name: tableName,
      value: [action],
    }));
  }

  function onUniqueConstraintCheck(prev: AnyTable, next: AnyTable) {
    const operations: Operation[] = [];
    const newConstraints = next.getUniqueConstraints();
    const oldConstraints = prev.getUniqueConstraints();

    for (const con of newConstraints) {
      const oldCon = oldConstraints.find((item) => item.name === con.name);
      const columnNames = con.columns.map((col) => getName(col.names));

      if (!oldCon) {
        operations.push({
          type: "add-unique-constraint",
          name: con.name,
          table: getName(next.names),
          columns: columnNames,
        });
        continue;
      }

      if (
        deepEqual(
          columnNames,
          oldCon.columns.map((col) => getName(col.names))
        )
      )
        continue;

      operations.push(
        {
          type: "drop-unique-constraint",
          table: getName(next.names),
          name: con.name,
        },
        {
          type: "add-unique-constraint",
          table: getName(next.names),
          name: con.name,
          columns: columnNames,
        }
      );
    }

    for (const con of oldConstraints) {
      const isUnused = newConstraints.every((item) => item.name !== con.name);

      if (isUnused)
        operations.push({
          type: "drop-unique-constraint",
          table: getName(next.names),
          name: con.name,
        });
    }

    return operations;
  }

  function onTableRenameCheck(oldTable: AnyTable, newTable: AnyTable) {
    const operations: Operation[] = [];

    if (getName(newTable.names) !== getName(oldTable.names)) {
      operations.push({
        type: "rename-table",
        from: getName(oldTable.names),
        to: getName(newTable.names),
        enforce: "pre",
      });
    }

    return operations;
  }

  function onTableColumnsCheck(
    oldTable: AnyTable,
    newTable: AnyTable
  ): Operation[] {
    const colActions: ColumnOperation[] = [];

    for (const column of Object.values(newTable.columns)) {
      const oldColumn = oldTable.columns[column.ormName];

      if (!oldColumn) {
        colActions.push({
          type: "create-column",
          value: column,
        });
        continue;
      }

      if (getName(column.names) !== getName(oldColumn.names)) {
        colActions.push({
          type: "rename-column",
          from: getName(oldColumn.names),
          to: getName(column.names),
        });
      }

      /**
       * Generate hash to compare default values
       */
      function hashDefaultValue(col: AnyColumn) {
        if (!col.default || "runtime" in col.default) return;
        if (col.type === "string" && provider === "mysql") return;

        return col.default.value;
      }

      const action: ColumnOperation = {
        type: "update-column",
        name: getName(column.names),
        updateDataType: column.type !== oldColumn.type,
        updateDefault: !deepEqual(
          hashDefaultValue(column),
          hashDefaultValue(oldColumn)
        ),
        updateNullable: column.isNullable !== oldColumn.isNullable,
        value: column,
      };

      if (isUpdated(action)) colActions.push(action);
    }

    return columnActionToOperation(getName(newTable.names), colActions);
  }

  function onTableForeignKeyCheck(
    oldTable: AnyTable,
    newTable: AnyTable
  ): Operation[] {
    const tableName = getName(newTable.names);
    const operations: Operation[] = [];
    if (relationMode === "@executor-js/fumadb") return operations;

    for (const foreignKey of newTable.foreignKeys) {
      const compiled = compileForeignKey(foreignKey, "sql");
      const oldKey = oldTable.foreignKeys.find(
        (key) => key.name === foreignKey.name
      );

      if (!oldKey) {
        operations.push({
          type: "add-foreign-key",
          table: tableName,
          value: compiled,
          enforce: "post",
        });
        continue;
      }

      const isUpdated = !deepEqual(compiled, compileForeignKey(oldKey, "sql"));
      if (isUpdated) {
        operations.push(
          {
            type: "drop-foreign-key",
            name: oldKey.name,
            table: tableName,
            enforce: "post",
          },
          {
            type: "add-foreign-key",
            table: tableName,
            value: compiled,
            enforce: "post",
          }
        );
      }
    }

    return operations;
  }

  function onTableUnusedForeignKeyCheck(
    oldTable: AnyTable,
    newTable: AnyTable
  ) {
    const operations: Operation[] = [];

    for (const oldKey of oldTable.foreignKeys) {
      const isUnused = newTable.foreignKeys.every(
        (key) => key.name !== oldKey.name
      );

      if (!isUnused) continue;
      operations.push({
        type: "drop-foreign-key",
        name: oldKey.name,
        table: getName(oldTable.names),
        enforce: "pre",
      });
    }

    return operations;
  }

  function onTableUnusedColumnsCheck(
    oldTable: AnyTable,
    newTable: AnyTable
  ): Operation[] {
    // this check happens after unique constraint check
    const constraints = newTable.getUniqueConstraints();
    const operations: Operation[] = [];

    for (const oldColumn of Object.values(oldTable.columns)) {
      const isUnused = !newTable.columns[oldColumn.ormName];
      const isRequired = !oldColumn.isNullable && !oldColumn.default;
      const shouldDrop = isUnused && (dropUnusedColumns || isRequired);

      if (!shouldDrop) continue;

      // mssql doesn't auto drop unique index/constraint
      if (provider === "mssql" && oldColumn.isUnique) {
        for (const con of constraints) {
          if (con.columns.every((col) => col.ormName !== oldColumn.ormName))
            continue;

          operations.push({
            type: "drop-unique-constraint",
            name: con.name,
            table: getName(newTable.names),
          });
        }
      }

      operations.push({
        type: "update-table",
        name: getName(newTable.names),
        value: [{ type: "drop-column", name: getName(oldColumn.names) }],
        enforce: "post",
      });
    }

    return operations;
  }

  function reorder(operations: Operation[]) {
    const out: MigrationOperation[] = [];
    for (const item of operations) {
      if (item.enforce === "pre") out.push(item);
    }

    for (const item of operations) {
      if (!item.enforce) out.push(item);
    }

    for (const item of operations) {
      if (item.enforce === "post") out.push(item);
    }

    return out;
  }

  function generate() {
    const operations: Operation[] = [];

    for (const table of Object.values(schema.tables)) {
      const oldTable = old.tables[table.ormName];
      if (!oldTable) {
        operations.push({
          type: "create-table",
          value: table,
        });
        continue;
      }

      operations.push(
        ...onTableUnusedForeignKeyCheck(oldTable, table),
        ...onTableRenameCheck(oldTable, table),
        ...onTableColumnsCheck(oldTable, table),
        ...onUniqueConstraintCheck(oldTable, table),
        ...onTableForeignKeyCheck(oldTable, table),
        ...onTableUnusedColumnsCheck(oldTable, table)
      );
    }

    for (const oldTable of Object.values(old.tables)) {
      if (!schema.tables[oldTable.ormName] && dropUnusedTables) {
        operations.push({
          type: "drop-table",
          name: getName(oldTable.names),
          enforce: "post",
        });
      }
    }

    return reorder(operations);
  }

  return generate();
}
