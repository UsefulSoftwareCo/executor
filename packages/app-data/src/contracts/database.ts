/** Portable, serialized app database declarations and operations. No product identity or database secrets cross this boundary. */
import { Schema, type Effect } from "effect";

/** Names have Lakebed's identifier shape and are always bound SQL values, never raw SQL. */
export const DataName = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && value.length <= 128),
);
/** Stored fields and index terms use finite scalar values; absent optional fields are represented by null in transport. */
export const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type Scalar = typeof Scalar.Type;
export const Field = Schema.Struct({
  kind: Schema.Literals(["string", "number", "boolean", "id", "userId"]),
  optional: Schema.optional(Schema.Boolean),
  default: Schema.optional(Scalar),
  references: Schema.optional(DataName),
});
export type Field = typeof Field.Type;
export const Index = Schema.Struct({ name: DataName, fields: Schema.NonEmptyArray(DataName) });
export const Table = Schema.Struct({
  fields: Schema.Record(DataName, Field),
  indexes: Schema.Array(Index),
});
export type Table = typeof Table.Type;
export const DatabaseSchema = Schema.Record(DataName, Table);
export type DatabaseSchema = typeof DatabaseSchema.Type;

/** The engine owns stable row identity and timestamps. */
export const Row = Schema.Record(Schema.String, Scalar);
export type Row = typeof Row.Type;
export const RowMetadata = Schema.Struct({
  id: Schema.NonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const Patch = Schema.Record(DataName, Schema.NullOr(Scalar));
export const RangeClause = Schema.Struct({
  field: DataName,
  op: Schema.Literals(["eq", "gt", "gte", "lt", "lte"]),
  value: Schema.NullOr(Scalar),
});
export const QueryPlan = Schema.Struct({
  table: DataName,
  index: DataName,
  order: Schema.Literals(["asc", "desc"]),
  clauses: Schema.Array(RangeClause),
});
export type QueryPlan = typeof QueryPlan.Type;
export const QueryTerminal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("collect") }),
  Schema.Struct({ kind: Schema.Literal("count") }),
  Schema.Struct({ kind: Schema.Literal("first") }),
  Schema.Struct({
    kind: Schema.Literal("take"),
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal("paginate"),
    cursor: Schema.NullOr(Schema.String),
    numItems: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export const DatabaseOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("get"), table: DataName, id: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("insert"), table: DataName, value: Patch }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    table: DataName,
    id: Schema.NonEmptyString,
    patch: Patch,
  }),
  Schema.Struct({ kind: Schema.Literal("delete"), table: DataName, id: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("query"), plan: QueryPlan, terminal: QueryTerminal }),
]);
export type DatabaseOperation = typeof DatabaseOperation.Type;
export const PaginationResult = Schema.Struct({
  page: Schema.Array(Row),
  continueCursor: Schema.NullOr(Schema.String),
  isDone: Schema.Boolean,
});
export const OperationResult = Schema.Union([
  Row,
  Schema.Array(Row),
  PaginationResult,
  Schema.Boolean,
  Schema.Finite,
  Schema.Null,
]);
export type OperationResult = typeof OperationResult.Type;

/** Safe expected failures, without supplied documents, SQL text, cursor payloads or credentials. */
export class AppDatabaseError extends Schema.TaggedError<AppDatabaseError>()("AppDatabaseError", {
  reason: Schema.Literals([
    "schema",
    "schema_changed",
    "table",
    "index",
    "range",
    "value",
    "readonly",
    "cursor",
    "limit",
    "closed",
    "storage",
    "replay",
  ]),
}) {}

/** Bounded work per authored operation. collect/count do not silently truncate. */
export const DatabaseLimits = Schema.Struct({
  rowsRead: Schema.Int.check(Schema.isGreaterThan(0)),
  rowsReturned: Schema.Int.check(Schema.isGreaterThan(0)),
  bytesRead: Schema.Int.check(Schema.isGreaterThan(0)),
  writes: Schema.Int.check(Schema.isGreaterThan(0)),
  scanCalls: Schema.Int.check(Schema.isGreaterThan(0)),
  directGets: Schema.Int.check(Schema.isGreaterThan(0)),
  valueBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  indexBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type DatabaseLimits = typeof DatabaseLimits.Type;
/** Current per-invocation budgets, shared by every database adapter. */
export const defaultDatabaseLimits: DatabaseLimits = {
  rowsRead: 5000,
  rowsReturned: 1000,
  bytesRead: 4 * 1024 * 1024,
  writes: 1000,
  scanCalls: 100,
  directGets: 1000,
  valueBytes: 64 * 1024,
  indexBytes: 2048,
};

/** Host resource bounds outside an individual database transaction. Durations are milliseconds. */
export const DatabaseRuntimeLimits = Schema.Struct({
  maxCursorChars: Schema.Int.check(Schema.isGreaterThan(0)),
  connectionCacheCapacity: Schema.Int.check(Schema.isGreaterThan(0)),
  connectionCacheTtlMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type DatabaseRuntimeLimits = typeof DatabaseRuntimeLimits.Type;
/** Cache eviction closes idle connections; it does not limit installed apps or expire their data. */
export const defaultDatabaseRuntimeLimits = DatabaseRuntimeLimits.make({
  maxCursorChars: 8192,
  connectionCacheCapacity: 64,
  connectionCacheTtlMs: 5 * 60 * 1000,
});

/** The host binds one database and read/write authority for the entire invocation. */
export interface DatabaseSession {
  /** Host-only idempotency receipt, committed atomically with the mutation and validated result. */
  readonly once: <E, R>(
    key: string,
    fingerprint: string,
    work: () => Effect.Effect<Schema.Json, E, R>,
  ) => Effect.Effect<Schema.Json, E | AppDatabaseError, R>;

  readonly readTables: ReadonlySet<string>;
  readonly changedTables: ReadonlySet<string>;
  readonly execute: (
    operation: DatabaseOperation,
  ) => Effect.Effect<OperationResult, AppDatabaseError>;
}
/** Native operation scope owns snapshot consistency, write rollback and commit notifications. */
export interface AppDatabase {
  readonly schema: DatabaseSchema;
  readonly schemaHash: string;
  readonly read: <A, E, R>(
    work: (session: DatabaseSession) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AppDatabaseError, R>;
  readonly mutate: <A, E, R>(
    work: (session: DatabaseSession) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AppDatabaseError, R>;
}

/** Product-independent app partitions. A host supplies persistent storage; callers never choose filenames. */
export interface AppDatabases {
  readonly read: <A, E>(
    app: string,
    schema: DatabaseSchema,
    work: (session: DatabaseSession) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AppDatabaseError>;
  readonly mutate: <A, E>(
    app: string,
    schema: DatabaseSchema,
    work: (session: DatabaseSession) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AppDatabaseError>;
}
