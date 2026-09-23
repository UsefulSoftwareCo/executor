/**
 * Table definitions.
 */
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

/** A named unique constraint over one or more columns of a table. */
export interface UniqueConstraint {
  readonly name: string;
  readonly columns: ReadonlyArray<AnyColumn>;
}

/** A table: columns keyed by ORM name, its relations, and its foreign keys. Construct with {@link table}. */
export interface Table<
  Columns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  Relations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  names: NameVariants;
  ormName: string;
  readonly columns: Columns;
  readonly relations: Relations;
  readonly foreignKeys: Array<ForeignKey>;

  /** @param level defaults to `"all"` */
  readonly getUniqueConstraints: (
    level?: "table" | "column" | "all",
  ) => ReadonlyArray<UniqueConstraint>;
  /** Look a column up by its SQL name. */
  readonly getColumnBySqlName: (name: string) => AnyColumn | undefined;
  readonly getIdColumn: () => AnyColumn;
  /**
   * Add a composite unique constraint. Duplicate `NULL` values stay allowed on every provider.
   * Every column must be indexable on every provider (no unbounded text, json, or binary).
   * (A method signature, so a concrete table stays assignable to `AnyTable`.)
   */
  unique(name: string, columns: ReadonlyArray<keyof Columns>): Table<Columns, Relations>;
  /**
   * Add a unique constraint without the indexability check. For constraints
   * that already exist in a database (introspection) and for cloning; a new
   * schema should use `unique`.
   */
  uniqueUnchecked(name: string, columns: ReadonlyArray<keyof Columns>): Table<Columns, Relations>;
  clone(): Table<Columns, Relations>;

  /** A selected row: every column's schema. */
  readonly row: Schema.Struct<RowFields<Columns>>;
  /** An insert: columns with a default or accepting `null` are optional. */
  readonly insert: Schema.Struct<InsertFields<Columns>>;
  /** An update: every column optional, the id column omitted. */
  readonly update: Schema.Struct<UpdateFields<Columns>>;
}

/** `true` when `Columns` is an index-signature record (the `AnyTable` case) rather than a concrete column map. */
type IsOpen<Columns> = string extends keyof Columns ? true : false;

/** The schema fields of a selected row. */
export type RowFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in keyof Columns]: Columns[K]["schema"];
      };

/**
 * Whether the stored (encoded) side of a column schema accepts `NULL`. The
 * check is on the encoded side because that is what `inferStorageType` and
 * the runtime insert struct use; `unknown` is guarded so a `Schema.Unknown`
 * json column stays required.
 */
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

/** The schema fields of an insert. */
export type InsertFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in Exclude<keyof Columns, OptionalOnInsert<Columns>>]: Columns[K]["schema"];
      } & { readonly [K in OptionalOnInsert<Columns>]: Schema.optionalKey<Columns[K]["schema"]> };

type NonIdKeys<Columns extends Record<string, AnyColumn>> = {
  [K in keyof Columns]: Columns[K] extends IdColumn<Schema.Top, boolean> ? never : K;
}[keyof Columns];

/** The schema fields of an update. */
export type UpdateFields<Columns extends Record<string, AnyColumn>> =
  IsOpen<Columns> extends true
    ? Schema.Struct.Fields
    : {
        readonly [K in NonIdKeys<Columns>]: Schema.optionalKey<Columns[K]["schema"]>;
      };

/** Any table, regardless of its column and relation types. */
export type AnyTable = Table;

/** Look a column up by ORM name, raising a defect when it is missing. Use only for names the schema validated. */
export const getColumn = (table: AnyTable, ormName: string): AnyColumn => {
  const column = table.columns[ormName];
  if (column === undefined) {
    throw new SchemaDefinitionError(`Unknown column "${ormName}" in table "${table.ormName}".`);
  }
  return column;
};

/**
 * Define a table.
 *
 * @param name the SQL name, or `{ sql }` overrides (defaults to the ORM name).
 * @param columns columns keyed by ORM name; exactly one must be an `idColumn`.
 */
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
