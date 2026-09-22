/** Promise boundary over a captured native database session. */
import { Effect, Schema } from "effect";
import {
  DatabaseOperation,
  PaginationResult,
  RangeClause,
  Row,
  type DatabaseSession,
  type QueryPlan,
} from "../contracts/database.ts";

/** Index predicates are accumulated immutably, then checked against the declaration by the engine. */
export interface IndexRange<Fields> {
  /** Constrain an index prefix field to one value. Null matches a cleared optional field. */
  readonly eq: <Key extends keyof Fields & string>(
    field: Key,
    value: Fields[Key] | null,
  ) => IndexRange<Fields>;
  /** Require a value greater than the bound on the next index field. */
  readonly gt: <Key extends keyof Fields & string>(
    field: Key,
    value: Fields[Key],
  ) => IndexRange<Fields>;
  /** Require a value greater than or equal to the bound on the next index field. */
  readonly gte: <Key extends keyof Fields & string>(
    field: Key,
    value: Fields[Key],
  ) => IndexRange<Fields>;
  /** Require a value less than the bound on the next index field. */
  readonly lt: <Key extends keyof Fields & string>(
    field: Key,
    value: Fields[Key],
  ) => IndexRange<Fields>;
  /** Require a value less than or equal to the bound on the next index field. */
  readonly lte: <Key extends keyof Fields & string>(
    field: Key,
    value: Fields[Key],
  ) => IndexRange<Fields>;
}
/** Bounded indexed reads; collect/count reject work beyond the invocation budget. */
export interface Query<Row> {
  /** Choose ascending or descending index order without changing this query. */
  readonly order: (direction: "asc" | "desc") => Query<Row>;
  /** Read all matching rows within the invocation budget; exceeding it fails. */
  readonly collect: () => Promise<readonly Row[]>;
  /** Count matching rows within the scan budget; exceeding it fails. */
  readonly count: () => Promise<number>;
  /** Read the first matching row, or null when no row matches. */
  readonly first: () => Promise<Row | null>;
  /** Read at most count matching rows within the invocation budget. */
  readonly take: (count: number) => Promise<readonly Row[]>;
  /** Read one cursor page. Return its rows, continuation cursor and completion flag. */
  readonly paginate: (options: {
    readonly numItems: number;
    readonly cursor: string | null;
  }) => Promise<{
    readonly page: readonly Row[];
    readonly continueCursor: string | null;
    readonly isDone: boolean;
  }>;
}
/** Typed table operations exposed to authored queries. */
export interface ReadTable<Row, Index extends string = string> {
  /** Read a complete row by ID, or null when it does not exist. */
  readonly get: (id: string) => Promise<Row | null>;
  /** Select a declared index or by_creation, with optional prefix and range constraints. */
  readonly withIndex: (
    index: Index | "by_creation",
    range?: (query: IndexRange<Row>) => IndexRange<Row>,
  ) => Query<Row>;
}
/** Writes are valid only inside their owning mutation. */
export interface WriteTable<Row, Insert, Index extends string = string> extends ReadTable<
  Row,
  Index
> {
  /** Insert authored fields and return the complete row with generated id, createdAt and updatedAt. */
  readonly insert: (value: Insert) => Promise<Row>;
  /** Patch authored fields and return the complete row, or null if the ID does not exist. */
  readonly update: (id: string, patch: Partial<Insert>) => Promise<Row | null>;
  /** Delete the row and return whether it existed. */
  readonly delete: (id: string) => Promise<boolean>;
}

/** Build an untyped transport facade; the author schema layer installs exact field and row decoders. */
export const promiseTable = (session: DatabaseSession, table: string, signal: AbortSignal) => {
  const execute = (input: unknown) =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(DatabaseOperation)(input).pipe(Effect.flatMap(session.execute)),
      { signal },
    );
  const query = (plan: QueryPlan): Query<Row> => ({
    order: (direction) => query({ ...plan, order: direction }),
    collect: async () =>
      Schema.decodeUnknownSync(Schema.Array(Row))(
        await execute({ kind: "query", plan, terminal: { kind: "collect" } }),
      ),
    count: async () =>
      Schema.decodeUnknownSync(Schema.Int)(
        await execute({ kind: "query", plan, terminal: { kind: "count" } }),
      ),
    first: async () =>
      Schema.decodeUnknownSync(Schema.NullOr(Row))(
        await execute({ kind: "query", plan, terminal: { kind: "first" } }),
      ),
    take: async (count) =>
      Schema.decodeUnknownSync(Schema.Array(Row))(
        await execute({ kind: "query", plan, terminal: { kind: "take", count } }),
      ),
    paginate: async (options) =>
      Schema.decodeUnknownSync(PaginationResult)(
        await execute({ kind: "query", plan, terminal: { kind: "paginate", ...options } }),
      ),
  });
  return {
    get: async (id: string) =>
      Schema.decodeUnknownSync(Schema.NullOr(Row))(await execute({ kind: "get", table, id })),
    insert: async (value: unknown) =>
      Schema.decodeUnknownSync(Row)(await execute({ kind: "insert", table, value })),
    update: async (id: string, patch: unknown) =>
      Schema.decodeUnknownSync(Schema.NullOr(Row))(
        await execute({ kind: "update", table, id, patch }),
      ),
    delete: async (id: string) =>
      Schema.decodeUnknownSync(Schema.Boolean)(await execute({ kind: "delete", table, id })),
    withIndex: (index: string, range?: (query: IndexRange<Row>) => IndexRange<Row>) => {
      const ranges = new WeakMap<object, QueryPlan["clauses"]>();
      const makeRange = (clauses: QueryPlan["clauses"]): IndexRange<Row> => {
        const predicate =
          (op: (typeof RangeClause.Type)["op"]) => (field: string, value: unknown) =>
            makeRange([
              ...clauses,
              Schema.decodeUnknownSync(RangeClause)({
                field,
                op,
                value: op === "eq" && value === undefined ? null : value,
              }),
            ]);
        const result: IndexRange<Row> = {
          eq: predicate("eq"),
          gt: predicate("gt"),
          gte: predicate("gte"),
          lt: predicate("lt"),
          lte: predicate("lte"),
        };
        ranges.set(result, clauses);
        return result;
      };
      const selected = range === undefined ? makeRange([]) : range(makeRange([]));
      const clauses = ranges.get(selected);
      if (clauses === undefined) throw new Error("Return the supplied index range");
      return query({ table, index, order: "asc", clauses });
    },
  };
};
