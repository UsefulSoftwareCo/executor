import { Schema } from "effect";
import { SchemaDefinitionError } from "../errors.ts";
import {
  type AnyColumn,
  assertIndexable,
  type Column,
  type IdColumn,
  isIdColumn,
} from "./column.ts";
import type { NameVariants } from "./names.ts";
import type { AnyRelation, ForeignKey } from "./relation.ts";

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: ReadonlyArray<AnyColumn>;
}

export interface Table<
  Columns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  Relations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  names: NameVariants;
  ormName: string;
  readonly columns: Columns;
  readonly relations: Relations;
  readonly foreignKeys: Array<ForeignKey>;

  readonly getUniqueConstraints: (
    level?: "table" | "column" | "all",
  ) => ReadonlyArray<UniqueConstraint>;
  readonly getColumnBySqlName: (name: string) => AnyColumn | undefined;
  readonly getIdColumn: () => AnyColumn;
  unique(name: string, columns: ReadonlyArray<keyof Columns>): Table<Columns, Relations>;
  uniqueUnchecked(name: string, columns: ReadonlyArray<keyof Columns>): Table<Columns, Relations>;
  clone(): Table<Columns, Relations>;

  readonly row: Schema.Struct<RowFields<Columns>>;
  readonly insert: Schema.Struct<InsertFields<Columns>>;
  readonly update: Schema.Struct<UpdateFields<Columns>>;
}

type IsOpen<Columns> = string extends keyof Columns ? true : false;

export type RowFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in keyof Columns]: Columns[K]["schema"];
      };

type HasNullishMember<Members extends ReadonlyArray<Schema.Constraint>> = true extends {
  [K in keyof Members]: Members[K] extends Schema.Null | Schema.Undefined ? true : false;
}[number]
  ? true
  : false;

type EncodedAcceptsNull<S extends Schema.Top> =
  S extends Schema.Union<infer Members>
    ? HasNullishMember<Members>
    : unknown extends S["Encoded"]
      ? false
      : null extends S["Encoded"]
        ? true
        : undefined extends S["Encoded"]
          ? true
          : false;

type OptionalOnInsert<Columns extends Record<string, AnyColumn>> = {
  [K in keyof Columns]: Columns[K] extends Column<infer S, infer HasDefault>
    ? HasDefault extends true
      ? K
      : EncodedAcceptsNull<S> extends true
        ? K
        : never
    : never;
}[keyof Columns];

export type InsertFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in Exclude<keyof Columns, OptionalOnInsert<Columns>>]: Columns[K]["schema"];
      } & { readonly [K in OptionalOnInsert<Columns>]: Schema.optionalKey<Columns[K]["schema"]> };

type NonIdKeys<Columns extends Record<string, AnyColumn>> = {
  [K in keyof Columns]: Columns[K] extends IdColumn<Schema.Top, boolean> ? never : K;
}[keyof Columns];

export type UpdateFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in NonIdKeys<Columns>]: Schema.optionalKey<Columns[K]["schema"]>;
      };

export type AnyTable = Table;

export const getColumn = (table: AnyTable, ormName: string): AnyColumn => {
  const column = table.columns[ormName];
  if (column === undefined) {
    throw new SchemaDefinitionError(`Unknown column "${ormName}" in table "${table.ormName}".`);
  }
  return column;
};

export const table = <Columns extends Record<string, AnyColumn>>(
  name: string | Partial<NameVariants>,
  columns: Columns,
): Table<Columns, {}> => {
  let idColumn: AnyColumn | undefined;
  let names: NameVariants | undefined;
  const uniqueConstraints: Array<UniqueConstraint> = [];

  const rowFields: Record<string, Schema.Top> = {};
  const insertFields: Record<string, Schema.Top> = {};
  const updateFields: Record<string, Schema.Top> = {};
  for (const [key, col] of Object.entries(columns)) {
    if (col === undefined) continue;
    rowFields[key] = col.schema;
    insertFields[key] =
      col.defaultValue !== undefined || col.isNullable
        ? Schema.optionalKey(col.schema)
        : col.schema;
    if (!isIdColumn(col)) updateFields[key] = Schema.optionalKey(col.schema);
  }

  const out: Table<Columns, {}> = {
    ormName: "",
    row: Schema.Struct(rowFields as RowFields<Columns>),
    insert: Schema.Struct(insertFields as InsertFields<Columns>),
    update: Schema.Struct(updateFields as UpdateFields<Columns>),
    get names(): NameVariants {
      if (names !== undefined) return names;
      return typeof name === "string" ? { sql: name } : { sql: name.sql ?? out.ormName };
    },
    set names(value: NameVariants) {
      names = value;
    },
    columns,
    relations: {},
    foreignKeys: [],
    getUniqueConstraints(level = "all") {
      const result: Array<UniqueConstraint> = [];
      if (level === "all" || level === "table") result.push(...uniqueConstraints);
      if (level === "all" || level === "column") {
        for (const col of Object.values(this.columns)) {
          if (!col.isUnique) continue;
          result.push({ name: col.getUniqueConstraintName(), columns: [col] });
        }
      }
      return result;
    },
    getColumnBySqlName(sqlName) {
      return Object.values(this.columns).find((c) => c.names.sql === sqlName);
    },
    getIdColumn() {
      if (idColumn === undefined)
        throw new SchemaDefinitionError(`Table "${out.ormName}" has no id column.`);
      return idColumn;
    },
    unique(constraintName, columnNames) {
      const constraintColumns = columnNames.map((columnName) =>
        getColumn(this, String(columnName)),
      );
      for (const col of constraintColumns) assertIndexable(col, `unique("${constraintName}")`);
      uniqueConstraints.push({ name: constraintName, columns: constraintColumns });
      return this;
    },
    uniqueUnchecked(constraintName, columnNames) {
      uniqueConstraints.push({
        name: constraintName,
        columns: columnNames.map((columnName) => getColumn(this, String(columnName))),
      });
      return this;
    },
    clone() {
      const clonedColumns: Record<string, AnyColumn> = {};
      for (const [key, value] of Object.entries(columns)) clonedColumns[key] = value.clone();
      const cloned = table(name, clonedColumns as Columns);
      cloned.ormName = this.ormName;
      if (names !== undefined) cloned.names = names;
      for (const con of uniqueConstraints) {
        cloned.uniqueUnchecked(
          con.name,
          con.columns.map((col) => col.ormName),
        );
      }
      return cloned;
    },
  };

  for (const key of Object.keys(columns)) {
    const col = columns[key];
    if (col === undefined) continue;
    col.table = out;
    col.ormName = key;
    if (isIdColumn(col)) {
      if (idColumn !== undefined) {
        throw new SchemaDefinitionError(
          `Table "${typeof name === "string" ? name : key}" has more than one id column.`,
        );
      }
      idColumn = col;
    }
  }

  if (idColumn === undefined) {
    throw new SchemaDefinitionError(
      `there's no id column in your table ${typeof name === "string" ? name : JSON.stringify(name)}`,
    );
  }

  return out;
};
