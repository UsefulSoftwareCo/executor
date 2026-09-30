import type {
  AnySchema,
  AnyTable,
  Relation,
  TableColumnValues,
  TableInsertValues,
  TableUpdateValues,
} from "../schema/create";
import type {
  JsonCountOptions,
  JsonGroupCountOptions,
  JsonGroupCountRow,
  JsonPageOptions,
  JsonStats,
  JsonStatsOptions,
  JsonTimeBucketOptions,
  JsonTimeBucketRow,
} from "./aggregate";
import type { Condition, ConditionBuilder } from "./condition-builder";
import type { ORMAdapter } from "./orm";

export type * from "./aggregate";
export type { Condition, ConditionBuilder } from "./condition-builder";
export { ConditionType } from "./condition-builder";
export { withQueryContext } from "./orm";
export type {
  CompiledJoin,
  ORMAdapter,
  SimplifiedCountOptions,
  SimplifyFindOptions,
} from "./orm";

export type AnySelectClause = SelectClause<AnyTable>;

export type SelectClause<T extends AnyTable> = true | (keyof T["columns"])[];

export type TableToColumnValues<T extends AnyTable> = TableColumnValues<T>;

export type TableToInsertValues<T extends AnyTable> = TableInsertValues<T>;

export type TableToUpdateValues<T extends AnyTable> = TableUpdateValues<T>;

export type MainSelectResult<
  S extends SelectClause<T>,
  T extends AnyTable,
> = S extends true
  ? TableToColumnValues<T>
  : S extends (keyof T["columns"])[]
    ? Pick<TableToColumnValues<T>, S[number]>
    : never;

export type JoinBuilder<T extends AnyTable, Out = {}> = {
  [K in keyof T["relations"]]: T["relations"][K] extends Relation<
    infer Type,
    infer Target
  >
    ? <Select extends SelectClause<Target> = true, JoinOut = {}>(
        options?: Type extends "many"
          ? FindManyOptions<Target, Select, JoinOut, false>
          : FindFirstOptions<Target, Select, JoinOut, false>
      ) => JoinBuilder<
        T,
        Out & {
          [$K in K]: MapRelationType<
            SelectResult<Target, JoinOut, Select>,
            T["relations"][K]["implied"]
          >[Type];
        }
      >
    : never;
};

export type SelectResult<
  T extends AnyTable,
  JoinOut,
  Select extends SelectClause<T>,
> = MainSelectResult<Select, T> & JoinOut;

export type OrderBy<Column = string> = [columnName: Column, "asc" | "desc"];

export type FindFirstOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
> = Omit<
  FindManyOptions<T, Select, JoinOut, IsRoot>,
  IsRoot extends true ? "limit" : "limit" | "offset" | "orderBy"
>;

interface MapRelationType<Type, Implied extends boolean> {
  one: Implied extends true ? Type | null : Type;
  many: Type[];
}

export type FindManyOptions<
  T extends AnyTable = AnyTable,
  Select extends SelectClause<T> = SelectClause<T>,
  JoinOut = {},
  IsRoot extends boolean = true,
> = {
  select?: Select;
  where?: (eb: ConditionBuilder<T["columns"]>) => Condition | boolean;

  limit?: number;
  orderBy?: OrderBy<keyof T["columns"]> | OrderBy<keyof T["columns"]>[];
  join?: (builder: JoinBuilder<T, {}>) => JoinBuilder<T, JoinOut>;
} & (IsRoot extends true
  ? {
      // drizzle doesn't support `offset` in join queries (this may be changed in future, we can add it back)
      offset?: number;
    }
  : {});

export interface AbstractQuery<S extends AnySchema> {
  internal: ORMAdapter<S>;

  /**
   * Rebind the query context used by table policies.
   *
   * Wrappers around `AbstractQuery` should forward this method instead of
   * rebuilding from `.internal`, otherwise public query decorators can be
   * bypassed.
   */
  withContext?: <TContext>(context: TContext) => AbstractQuery<S>;

  /**
   * The code in the transaction will receive a transaction query instance.
   *
   * If you use that instance to write the database (e.g. insert) and an error is thrown, FumaDB will automatically rollback the changes + rethrow the error.
   *
   * It works by using the transaction API that's natively available for the database/ORM, or falling back to the soft transaction layer built by FumaDB.
   */
  transaction: <T>(run: (orm: AbstractQuery<S>) => Promise<T>) => Promise<T>;

  /**
   * Count (all)
   */
  count: <TableName extends keyof S["tables"]>(
    table: TableName,
    v?: {
      where?: (
        eb: ConditionBuilder<S["tables"][TableName]["columns"]>
      ) => Condition | boolean;
    }
  ) => Promise<number>;

  findFirst: <
      TableName extends keyof S["tables"],
      JoinOut = {},
      Select extends SelectClause<S["tables"][TableName]> = true,
    >(
      table: TableName,
      v: FindFirstOptions<S["tables"][TableName], Select, JoinOut>) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select> | null>;

  findMany: <
      TableName extends keyof S["tables"],
      JoinOut = {},
      Select extends SelectClause<S["tables"][TableName]> = true,
    >(
      table: TableName,
      v?: FindManyOptions<S["tables"][TableName], Select, JoinOut>) => Promise<SelectResult<S["tables"][TableName], JoinOut, Select>[]>;

  // not every database supports returning in update/delete, hence they will not be implemented.
  // TODO: maybe reconsider this in future

  /**
   * Upsert a **single row**.
   *
   * For ORMs:
   * - use built-in method whenever possible.
   *
   * Otherwise:
   * - run `update`.
   * - if updated zero rows, run `create`.
   */
  upsert: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      where: (
        eb: ConditionBuilder<S["tables"][TableName]["columns"]>
      ) => Condition | boolean;
      update: TableToUpdateValues<S["tables"][TableName]>;
      create: TableToInsertValues<S["tables"][TableName]>;
    }
  ) => Promise<void>;

  /**
   * Bulk upsert rows by a unique column target.
   *
   * Adapters with native conflict support should implement this as one or more
   * `INSERT ... ON CONFLICT ... DO UPDATE` statements. Other adapters may fall
   * back to per-row `upsert`.
   */
  upsertMany: <TableName extends keyof S["tables"]>(
    table: TableName,
    v: {
      target: (keyof S["tables"][TableName]["columns"])[];
      update: (keyof S["tables"][TableName]["columns"])[];
      values: TableToInsertValues<S["tables"][TableName]>[];
    }
  ) => Promise<void>;

  /**
   * Note: you cannot update the id of a row, some databases don't support that (including MongoDB).
   */
  updateMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      v: {
        where?: (
          eb: ConditionBuilder<S["tables"][TableName]["columns"]>
        ) => Condition | boolean;
        set: TableToUpdateValues<S["tables"][TableName]>;
      }) => Promise<void>;

  createMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      values: TableToInsertValues<S["tables"][TableName]>[]) => Promise<
      {
        _id: string;
      }[]
    >;

  /**
   * Note: when you don't need to receive the result, always use `createMany` for better performance.
   */
  create: <TableName extends keyof S["tables"]>(
      table: TableName,
      values: TableToInsertValues<S["tables"][TableName]>) => Promise<TableToColumnValues<S["tables"][TableName]>>;

  deleteMany: <TableName extends keyof S["tables"]>(
      table: TableName,
      v: {
        where?: (
          eb: ConditionBuilder<S["tables"][TableName]["columns"]>
        ) => Condition | boolean;
      }) => Promise<void>;

  // --- JSON-document aggregation + keyset pagination -----------------------
  // Operate over values addressed inside a JSON document column. Only adapters
  // that implement the matching `ORMAdapter` hooks support these; the rest
  // throw `[FumaDB] <op> is not supported by this adapter`.

  /** Count rows matching the real-column `where` and JSON-path `filter`. */
  jsonCount: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: JsonCountOptions<S["tables"][TableName]["columns"]>
  ) => Promise<number>;

  /** Group by a JSON path and count rows per distinct value. */
  jsonGroupCount: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: JsonGroupCountOptions<S["tables"][TableName]["columns"]>
  ) => Promise<JsonGroupCountRow[]>;

  /** Bucket a numeric JSON path by `bucketMs` and count rows per bucket. */
  jsonTimeBuckets: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: JsonTimeBucketOptions<S["tables"][TableName]["columns"]>
  ) => Promise<JsonTimeBucketRow[]>;

  /** Compute count/min/max and percentiles over a numeric JSON path. */
  jsonStats: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: JsonStatsOptions<S["tables"][TableName]["columns"]>
  ) => Promise<JsonStats>;

  /** Keyset-paginate rows ordered by JSON paths with a real-column tiebreak. */
  jsonPage: <TableName extends keyof S["tables"]>(
    table: TableName,
    options: JsonPageOptions<S["tables"][TableName]["columns"]>
  ) => Promise<TableToColumnValues<S["tables"][TableName]>[]>;
}
