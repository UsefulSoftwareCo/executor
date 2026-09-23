/**
 * Migration operations: the provider-independent plan produced by the schema
 * diff and consumed by each adapter's DDL generator.
 */
import type { AnyColumn } from "./schema/column.ts";
import type { ForeignKeyAction } from "./schema/relation.ts";
import type { AnyTable } from "./schema/table.ts";

/** Foreign key with all identifiers resolved to SQL names. */
export interface ForeignKeyInfo {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly referencedTable: string;
  readonly referencedColumns: ReadonlyArray<string>;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

/** A change to one column of an existing table. */
export type ColumnOperation =
  | { readonly type: "rename-column"; readonly from: string; readonly to: string }
  | { readonly type: "drop-column"; readonly name: string }
  /** Unique constraints are not created here; use `add-unique-constraint`. */
  | { readonly type: "create-column"; readonly value: AnyColumn }
  /**
   * Not supported by SQLite (the SQLite transformer rewrites it into a table recreate).
   * `value` is the full column definition because MySQL needs it; the flags say what changed.
   */
  | {
      readonly type: "update-column";
      readonly name: string;
      readonly value: AnyColumn;
      readonly updateNullable: boolean;
      readonly updateDefault: boolean;
      readonly updateDataType: boolean;
    };

/** A change to a table as a whole. */
export type TableOperation =
  | {
      readonly type: "create-table";
      readonly value: AnyTable;
      readonly skipForeignKeys?: boolean;
      readonly skipUniqueIndexes?: boolean;
    }
  | { readonly type: "drop-table"; readonly name: string }
  /** Changing a table's primary key is not supported. */
  | {
      readonly type: "update-table";
      readonly name: string;
      readonly value: ReadonlyArray<ColumnOperation>;
    }
  | { readonly type: "rename-table"; readonly from: string; readonly to: string };

/** A raw statement, emitted by settings updates and by the SQLite transformer. */
export interface CustomOperation {
  readonly type: "custom";
  readonly sql: string;
}

/** One step of a migration plan, independent of any provider. */
export type MigrationOperation =
  | TableOperation
  /** Not supported by SQLite. */
  | { readonly type: "add-foreign-key"; readonly table: string; readonly value: ForeignKeyInfo }
  /** Not supported by SQLite. */
  | { readonly type: "drop-foreign-key"; readonly table: string; readonly name: string }
  | { readonly type: "drop-unique-constraint"; readonly table: string; readonly name: string }
  | {
      readonly type: "add-unique-constraint";
      readonly table: string;
      readonly name: string;
      readonly columns: ReadonlyArray<string>;
    }
  | CustomOperation;

/** Whether an `update-column` operation changes anything. */
export const isColumnUpdated = (op: Extract<ColumnOperation, { type: "update-column" }>): boolean =>
  op.updateDataType || op.updateDefault || op.updateNullable;
