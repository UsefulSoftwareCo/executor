import type { AnyColumn, AnyTable } from "../schema/create";

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: "RESTRICT" | "CASCADE" | "SET NULL";
  onDelete: "RESTRICT" | "CASCADE" | "SET NULL";
}

export type MigrationOperation =
  | TableOperation
  | {
      // warning: not supported by SQLite
      type: "add-foreign-key";
      table: string;
      value: ForeignKeyInfo;
    }
  | {
      // warning: not supported by SQLite
      type: "drop-foreign-key";
      table: string;
      name: string;
    }
  | {
      type: "drop-unique-constraint";
      table: string;
      name: string;
    }
  | {
      type: "add-unique-constraint";
      table: string;
      columns: string[];
      name: string;
    }
  | CustomOperation;

export type CustomOperation = {
  type: "custom";
} & Record<string, unknown>;

export type TableOperation =
  | {
      type: "create-table";
      value: AnyTable;
    }
  | {
      type: "drop-table";
      name: string;
    }
  | {
      /**
       * Not supported by FumaDB
       * - update table's primary key
       */
      type: "update-table";
      name: string;
      value: ColumnOperation[];
    }
  | {
      type: "rename-table";
      from: string;
      to: string;
    };

export type ColumnOperation =
  | {
      type: "rename-column";
      from: string;
      to: string;
    }
  | {
      type: "drop-column";
      name: string;
    }
  | {
      /**
       * Note: unique constraints are not created, please use dedicated operations like `add-unique-constraint` instead
       */
      type: "create-column";
      value: AnyColumn;
    }
  | {
      /**
       * warning: Not supported by SQLite
       */
      type: "update-column";
      name: string;
      /**
       * For databases like MySQL, it requires the full definition for any modify column statement.
       * Hence, you need to specify the full information of your column here.
       *
       * Then, opt-in for in-detail modification for other databases that supports changing data type/nullable/default separately, such as PostgreSQL.
       *
       * Note: unique constraints are not updated, please use dedicated operations like `add-unique-constraint` instead
       */
      value: AnyColumn;

      updateNullable: boolean;
      updateDefault: boolean;
      updateDataType: boolean;
    };

export function isUpdated(
  op: Extract<ColumnOperation, { type: "update-column" }>
): boolean {
  return op.updateDataType || op.updateDefault || op.updateNullable;
}
