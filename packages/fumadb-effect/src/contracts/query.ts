/**
 * The unified query interface a library uses against a consumer's database.
 *
 * Every operation is an `Effect` that fails with `SqlError` (driver) or
 * `QueryError` (bad input or undecodable result) and needs the adapter's
 * environment `R`. For the SQL adapter, `R` is `SqlClient.SqlClient`.
 */
import type { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { QueryError } from "./errors.ts";
import type { Relation } from "./schema/relation.ts";
import type { AnySchema } from "./schema/schema.ts";
import type { AnyTable } from "./schema/table.ts";
import type { ConditionBuilder, ConditionResult } from "./condition.ts";

/** Failures of any query operation. */
export type OrmError = SqlError | QueryError;

/** `true` selects every column; an array selects the listed ORM column names. */
export type SelectClause<T extends AnyTable> = true | ReadonlyArray<keyof T["columns"]>;
/** A select clause for any table. */
export type AnySelectClause = SelectClause<AnyTable>;

/** Portable database-side projections over JSON arrays. */
export type ComputedSelect<T extends AnyTable> = {
  readonly kind: "jsonArrayLength";
  readonly column: keyof T["columns"];
  readonly alias: string;
};
type ComputedResult<C> =
  C extends ReadonlyArray<ComputedSelect<AnyTable>>
    ? { readonly [K in C[number]["alias"]]: number | null }
    : {};

/** A selected row with every column: the table's `row` schema type. */
type TableToColumnValues<T extends AnyTable> = T["row"]["Type"];

/** Insert values: the table's `insert` schema type (defaulted and nullable columns optional). */
export type TableToInsertValues<T extends AnyTable> = T["insert"]["Type"];

/** Update values: the table's `update` schema type (every column optional, no id column). */
export type TableToUpdateValues<T extends AnyTable> = T["update"]["Type"];

type MainSelectResult<S extends SelectClause<T>, T extends AnyTable> = S extends true
  ? TableToColumnValues<T>
  : S extends ReadonlyArray<keyof T["columns"]>
    ? Pick<TableToColumnValues<T>, Extract<S[number], keyof TableToColumnValues<T>>>
    : never;

/**
 * How a joined relation appears in a row. A `one` relation is `null` when no
 * related row exists: an implied one-to-one may have no counterpart, and an
 * explicit relation joins through columns that may be `NULL`.
 */
interface MapRelationType<Type> {
  one: Type | null;
  many: Array<Type>;
}

/**
 * The `join` callback argument: one method per relation. Each call adds the
 * relation to the result type and returns the builder for chaining.
 */
export type JoinBuilder<T extends AnyTable, Out = {}, Joined extends PropertyKey = never> = {
  [K in Exclude<keyof T["relations"], Joined>]: T["relations"][K] extends Relation<
    infer Type,
    infer Target
  >
    ? <Select extends SelectClause<Target> = true, JoinOut = {}>(
        options?: Type extends "many"
          ? FindManyOptions<Target, Select, JoinOut, false>
          : FindFirstOptions<Target, Select, JoinOut, false>,
      ) => JoinBuilder<
        T,
        Out & {
          [$K in K]: MapRelationType<SelectResult<Target, JoinOut, Select>>[Type];
        },
        Joined | K
      >
    : never;
};

/** The row type of a find: the selected columns plus every joined relation. */
export type SelectResult<
  T extends AnyTable,
  JoinOut,
  Select extends SelectClause<T>,
> = MainSelectResult<Select, T> & JoinOut;

/** One sort key: a column and a direction. */
export type OrderBy<Column = string> = readonly [column: Column, direction: "asc" | "desc"];

/** A `where` callback: builds a condition from the table's columns. */
export type WhereFn<T extends AnyTable> = (
  builder: ConditionBuilder<T["columns"]>,
) => ConditionResult;

/**
 * Options of `findMany`. `offset` is only available on the root query,
 * because joined queries cannot page.
 */
export type FindManyOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
  Computed extends ReadonlyArray<ComputedSelect<T>> | undefined = undefined,
> = {
  readonly select?: Select | undefined;
  readonly computed?: IsRoot extends true ? Computed : never;
  readonly where?: WhereFn<T> | undefined;
  readonly limit?: number | undefined;
  readonly orderBy?:
    | OrderBy<keyof T["columns"]>
    | ReadonlyArray<OrderBy<keyof T["columns"]>>
    | undefined;
  readonly join?:
    | ((builder: JoinBuilder<T, {}>) => JoinBuilder<T, JoinOut, PropertyKey>)
    | undefined;
} & (IsRoot extends true ? { readonly offset?: number | undefined } : {});

/** Options of `findFirst`: `findMany` without `limit` (and, inside a join, without `offset` and `orderBy`). */
export type FindFirstOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
  Computed extends ReadonlyArray<ComputedSelect<T>> | undefined = undefined,
> = Omit<
  FindManyOptions<T, Select, JoinOut, IsRoot, Computed>,
  IsRoot extends true ? "limit" : "limit" | "offset" | "orderBy"
>;

/** Options of `count`. */
export interface CountOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
}

/** Options of `updateMany`. Without `where`, every row is updated. */
export interface UpdateManyOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
  readonly set: TableToUpdateValues<T>;
}

/** Options of `deleteMany`. Without `where`, every row is deleted. */
export interface DeleteManyOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
}

/** Options of `upsert`. */
export interface UpsertOptions<T extends AnyTable, Returning extends boolean = false> {
  readonly where: WhereFn<T>;
  readonly create: TableToInsertValues<T>;
  readonly update: TableToUpdateValues<T>;
  /**
   * Return the created or updated row. Providers with a returning clause
   * (PostgreSQL, CockroachDB, SQLite, MSSQL) read it from the write itself;
   * MySQL runs one extra select.
   */
  readonly returning?: Returning | undefined;
}

export type { TableToColumnValues };

/**
 * Query interface for one schema version.
 *
 * `R` is the environment the adapter needs (for example `SqlClient.SqlClient`).
 */
export interface Orm<S extends AnySchema, R> {
  readonly schema: S;

  /**
   * Run `effect` inside a database transaction. Writes are rolled back when
   * the effect fails or is interrupted. Nested calls use savepoints.
   */
  readonly transaction: <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E | SqlError, R | R2>;

  readonly count: <TableName extends keyof S["tables"]>(
    table: TableName,
    options?: CountOptions<S["tables"][TableName]>,
  ) => Effect.Effect<number, OrmError, R>;

  readonly findFirst: <
    TableName extends keyof S["tables"],
    JoinOut = {},
    Select extends SelectClause<S["tables"][TableName]> = true,
    const Computed extends ReadonlyArray<ComputedSelect<S["tables"][TableName]>> | undefined =
      undefined,
  >(
    table: TableName,
    options?: FindFirstOptions<S["tables"][TableName], Select, JoinOut, true, Computed>,
  ) => Effect.Effect<
    (SelectResult<S["tables"][TableName], JoinOut, Select> & ComputedResult<Computed>) | null,
    OrmError,
    R
  >;

  readonly findMany: <
    TableName extends keyof S["tables"],
    JoinOut = {},
    Select extends SelectClause<S["tables"][TableName]> = true,
    const Computed extends ReadonlyArray<ComputedSelect<S["tables"][TableName]>> | undefined =
      undefined,
  >(
    table: TableName,
    options?: FindManyOptions<S["tables"][TableName], Select, JoinOut, true, Computed>,
  ) => Effect.Effect<
    Array<SelectResult<S["tables"][TableName], JoinOut, Select> & ComputedResult<Computed>>,
    OrmError,
    R
  >;

  /**
   * Upsert a single row: update the first row matching `where`, or create one.
   * With `returning: true` the created or updated row is returned.
   */
  readonly upsert: {
    <TableName extends keyof S["tables"]>(
      table: TableName,
      options: UpsertOptions<S["tables"][TableName], false>,
    ): Effect.Effect<void, OrmError, R>;
    <TableName extends keyof S["tables"]>(
      table: TableName,
      options: UpsertOptions<S["tables"][TableName], true>,
    ): Effect.Effect<TableToColumnValues<S["tables"][TableName]>, OrmError, R>;
  };

  /** The id column cannot be updated. */
  readonly updateMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: UpdateManyOptions<S["tables"][TableName]>,
  ) => Effect.Effect<void, OrmError, R>;

  readonly createMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: ReadonlyArray<TableToInsertValues<S["tables"][TableName]>>,
  ) => Effect.Effect<Array<{ readonly _id: unknown }>, OrmError, R>;

  /** Prefer `createMany` when the created row is not needed. */
  readonly create: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>,
  ) => Effect.Effect<TableToColumnValues<S["tables"][TableName]>, OrmError, R>;

  readonly deleteMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    options?: DeleteManyOptions<S["tables"][TableName]>,
  ) => Effect.Effect<void, OrmError, R>;
}

/** An `Orm` over any schema. */
export type AnyOrm<R = never> = Orm<AnySchema, R>;
