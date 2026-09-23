/** Resolved query inputs implemented by storage adapters. */
import type { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AnyColumn } from "./schema/column.ts";
import type { AnyRelation } from "./schema/relation.ts";
import type { AnyTable } from "./schema/table.ts";
import type { Condition } from "./condition.ts";
import type { AnySelectClause, OrderBy, OrmError } from "./query.ts";

/** One database row, keyed by ORM column name. */
export type Row = Record<string, unknown>;

/** One joined relation of a compiled find. */
export interface CompiledJoin {
  readonly relation: AnyRelation;
  /** `false` when the join's `where` can never match. */
  readonly options: CompiledFindOptions | false;
}

/** `findFirst` / `findMany` options with names resolved and constant conditions folded. */
export interface CompiledFindOptions {
  readonly select: AnySelectClause;
  readonly computed: ReadonlyArray<{
    readonly kind: "jsonArrayLength";
    readonly column: AnyColumn;
    readonly alias: string;
  }>;
  readonly where: Condition | undefined;
  readonly orderBy: ReadonlyArray<OrderBy<AnyColumn>> | undefined;
  readonly join: ReadonlyArray<CompiledJoin> | undefined;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/** `upsert` options with names resolved. `where` is absent when it matches every row. */
export interface CompiledUpsert {
  readonly where: Condition | undefined;
  readonly create: Row;
  readonly update: Row;
  readonly returning: boolean;
}

/**
 * What an adapter implements. Every method receives a resolved table and
 * compiled options; the ORM layer has already handled constant conditions.
 */
export interface OrmAdapter<R> {
  readonly tables: Record<string, AnyTable>;
  readonly count: (
    table: AnyTable,
    options: { readonly where: Condition | undefined },
  ) => Effect.Effect<number, OrmError, R>;
  readonly findFirst: (
    table: AnyTable,
    options: CompiledFindOptions,
  ) => Effect.Effect<Row | null, OrmError, R>;
  readonly findMany: (
    table: AnyTable,
    options: CompiledFindOptions,
  ) => Effect.Effect<Array<Row>, OrmError, R>;
  readonly updateMany: (
    table: AnyTable,
    options: { readonly where: Condition | undefined; readonly set: Row },
  ) => Effect.Effect<void, OrmError, R>;
  /**
   * When `returning` is set, the created or updated row must be returned with
   * every column. Prefer a returning clause; otherwise run an extra query.
   */
  readonly upsert: (
    table: AnyTable,
    options: CompiledUpsert,
  ) => Effect.Effect<Row | undefined, OrmError, R>;
  readonly create: (table: AnyTable, values: Row) => Effect.Effect<Row, OrmError, R>;
  readonly createMany: (
    table: AnyTable,
    values: ReadonlyArray<Row>,
  ) => Effect.Effect<Array<{ readonly _id: unknown }>, OrmError, R>;
  readonly deleteMany: (
    table: AnyTable,
    options: { readonly where: Condition | undefined },
  ) => Effect.Effect<void, OrmError, R>;
  readonly transaction: <A, E, R2>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E | SqlError, R | R2>;
}
