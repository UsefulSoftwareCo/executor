import { Schema, type Effect, type Scope, type Stream } from "effect";

export interface QuerySnapshot<A> {
  readonly revision: number;
  readonly value: A;
}

export interface TrackedQuerySnapshot<A> extends QuerySnapshot<A> {
  readonly tables: ReadonlyArray<string>;
}

export interface StoreChange {
  readonly namespace: string;
  readonly revision: number;
  readonly tables: ReadonlyArray<string>;
}

export interface ReactiveStore {
  readonly namespace: string;
  readonly inTransaction: Effect.Effect<boolean>;
  readonly read: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly write: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly subscribe: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Stream.Stream<QuerySnapshot<A>, E, Exclude<R, Scope.Scope>>;
  readonly evaluate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<TrackedQuerySnapshot<A>, E, R>;
  readonly changes: Stream.Stream<StoreChange>;
}

export const QueryId = Schema.String.pipe(Schema.brand("LiveQueryId"));
export type QueryId = typeof QueryId.Type;

export const SubscriptionDescriptor = Schema.Struct({
  namespace: Schema.String,
  query: QueryId,
  arguments: Schema.Json,
  caller: Schema.String,
});
export type SubscriptionDescriptor = typeof SubscriptionDescriptor.Type;
