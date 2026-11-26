import type { AnyColumn } from "./schema/column.ts";
import type { ForeignKeyAction } from "./schema/relation.ts";
import type { AnyTable } from "./schema/table.ts";

export interface ForeignKeyInfo {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly referencedTable: string;
  readonly referencedColumns: ReadonlyArray<string>;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

export type ColumnOperation =
  | { readonly type: "rename-column"; readonly from: string; readonly to: string }
  | { readonly type: "drop-column"; readonly name: string }
  | { readonly type: "create-column"; readonly value: AnyColumn }
  | {
      readonly type: "update-column";
      readonly name: string;
      readonly value: AnyColumn;
      readonly updateNullable: boolean;
      readonly updateDefault: boolean;
      readonly updateDataType: boolean;
    };

export type TableOperation =
  | {
      readonly type: "create-table";
      readonly value: AnyTable;
      readonly skipForeignKeys?: boolean;
      readonly skipUniqueIndexes?: boolean;
    }
  | { readonly type: "drop-table"; readonly name: string }
  | {
      readonly type: "update-table";
      readonly name: string;
      readonly value: ReadonlyArray<ColumnOperation>;
    }
  | { readonly type: "rename-table"; readonly from: string; readonly to: string };

export interface CustomOperation {
  readonly type: "custom";
  readonly sql: string;
}

export type MigrationOperation =
  | TableOperation
  | { readonly type: "add-foreign-key"; readonly table: string; readonly value: ForeignKeyInfo }
  | { readonly type: "drop-foreign-key"; readonly table: string; readonly name: string }
  | { readonly type: "drop-unique-constraint"; readonly table: string; readonly name: string }
  | {
      readonly type: "add-unique-constraint";
      readonly table: string;
      readonly name: string;
      readonly columns: ReadonlyArray<string>;
    }
  | CustomOperation;

export const isColumnUpdated = (op: Extract<ColumnOperation, { type: "update-column" }>): boolean =>
  op.updateDataType || op.updateDefault || op.updateNullable;
