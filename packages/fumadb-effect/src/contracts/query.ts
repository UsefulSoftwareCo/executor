import type { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { QueryError } from "./errors.ts";
import type { Relation } from "./schema/relation.ts";
import type { AnySchema } from "./schema/schema.ts";
import type { AnyTable } from "./schema/table.ts";
import type { ConditionBuilder, ConditionResult } from "./condition.ts";

export type OrmError = SqlError | QueryError;

export type SelectClause<T extends AnyTable> = true | ReadonlyArray<keyof T["columns"]>;
export type AnySelectClause = SelectClause<AnyTable>;

export type ComputedSelect<T extends AnyTable> = {
  readonly kind: "jsonArrayLength";
  readonly column: keyof T["columns"];
  readonly alias: string;
};
type ComputedResult<C> =
  C extends ReadonlyArray<ComputedSelect<AnyTable>>
    ? { readonly [K in C[number]["alias"]]: number | null }
    : {};

type TableToColumnValues<T extends AnyTable> = T["row"]["Type"];

export type TableToInsertValues<T extends AnyTable> = T["insert"]["Type"];

export type TableToUpdateValues<T extends AnyTable> = T["update"]["Type"];

type MainSelectResult<S extends SelectClause<T>, T extends AnyTable> = S extends true
  ? TableToColumnValues<T>
  : S extends ReadonlyArray<keyof T["columns"]>
    ? Pick<TableToColumnValues<T>, Extract<S[number], keyof TableToColumnValues<T>>>
    : never;

interface MapRelationType<Type> {
  one: Type | null;
  many: Array<Type>;
}

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

export type SelectResult<
  T extends AnyTable,
  JoinOut,
  Select extends SelectClause<T>,
> = MainSelectResult<Select, T> & JoinOut;

export type OrderBy<Column = string> = readonly [column: Column, direction: "asc" | "desc"];

export type WhereFn<T extends AnyTable> = (
  builder: ConditionBuilder<T["columns"]>,
) => ConditionResult;

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

export interface CountOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
}

export interface UpdateManyOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
  readonly set: TableToUpdateValues<T>;
}

export interface DeleteManyOptions<T extends AnyTable> {
  readonly where?: WhereFn<T> | undefined;
}

export interface UpsertOptions<T extends AnyTable, Returning extends boolean = false> {
  readonly where: WhereFn<T>;
  readonly create: TableToInsertValues<T>;
  readonly update: TableToUpdateValues<T>;
  readonly returning?: Returning | undefined;
}

export type { TableToColumnValues };

export interface Orm<S extends AnySchema, R> {
  readonly schema: S;

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

  readonly updateMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: UpdateManyOptions<S["tables"][TableName]>,
  ) => Effect.Effect<void, OrmError, R>;

  readonly createMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: ReadonlyArray<TableToInsertValues<S["tables"][TableName]>>,
  ) => Effect.Effect<Array<{ readonly _id: unknown }>, OrmError, R>;

  readonly create: <TableName extends keyof S["tables"]>(
    table: TableName,
    values: TableToInsertValues<S["tables"][TableName]>,
  ) => Effect.Effect<TableToColumnValues<S["tables"][TableName]>, OrmError, R>;

  readonly deleteMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    options?: DeleteManyOptions<S["tables"][TableName]>,
  ) => Effect.Effect<void, OrmError, R>;
}

export type AnyOrm<R = never> = Orm<AnySchema, R>;
