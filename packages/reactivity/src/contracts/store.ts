import { Schema, type Effect, type Scope, type Stream } from "effect";

/** A process-local revision and current query result, never an incremental patch. */
export interface QuerySnapshot<A> {
  readonly revision: number;
  readonly value: A;
}

/** A current value and its actual table dependencies, for durable coordinators. */
export interface TrackedQuerySnapshot<A> extends QuerySnapshot<A> {
  readonly tables: ReadonlyArray<string>;
}

/** Committed table changes. Revisions restart with the coordinator process. */
export interface StoreChange {
  readonly namespace: string;
  readonly revision: number;
  readonly tables: ReadonlyArray<string>;
}

/**
 * Automatic dependency tracking for one database/coordinator. All its controlled
 * writes must pass through this instance. Table keys may include app identity.
 */
export interface ReactiveStore {
  /** Stable host-supplied database identity; not an authorization boundary. */
  readonly namespace: string;
  /** Whether the current fiber is inside this coordinator's transaction boundary. */
  readonly inTransaction: Effect.Effect<boolean>;
  /** Record dependencies before a read, including reads returning no rows. */
  readonly read: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Record successful writes in an enclosing transaction, or publish after a
   * standalone atomic write. The effect must commit or roll back atomically.
   */
  readonly write: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Wrap the SQL driver's transaction effect, not its inner body. Publishes only
   * after success, so failed transactions/savepoints never leak invalidations.
   * Keep this database-only: commit plus notification is uninterruptible.
   */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Run now and after relevant commits. Captures a fresh set of actual read
   * dependencies per run. Every new subscription starts with a full snapshot.
   * Query effects must be read-only and must recheck caller authorization.
   */
  readonly subscribe: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Stream.Stream<QuerySnapshot<A>, E, Exclude<R, Scope.Scope>>;
  /** Evaluate once with read tracking; used to persist a subscription after wake. */
  readonly evaluate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<TrackedQuerySnapshot<A>, E, R>;
  /** Metadata-only wake-up stream. The first event asks for a fresh snapshot. */
  readonly changes: Stream.Stream<StoreChange>;
}

/** Query names are stable author/host names, never serialized executable code. */
export const QueryId = Schema.String.pipe(Schema.brand("LiveQueryId"));
/** A stable name used to resolve a live query on the receiving host. */
export type QueryId = typeof QueryId.Type;

/**
 * Persistable subscription description. Caller is an opaque host identity,
 * never a bearer token, credential, or retained authorization decision. A host
 * must authenticate the registering socket and authorize each evaluation.
 */
export const SubscriptionDescriptor = Schema.Struct({
  namespace: Schema.String,
  query: QueryId,
  arguments: Schema.Json,
  caller: Schema.String,
});
/** Parsed, serializable data needed to reconstruct a subscription after wake. */
export type SubscriptionDescriptor = typeof SubscriptionDescriptor.Type;
