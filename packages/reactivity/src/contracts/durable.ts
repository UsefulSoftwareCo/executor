import { Schema, type Effect } from "effect";
import type { SubscriptionDescriptor } from "./store.ts";

export class LiveQueryError extends Schema.TaggedError<LiveQueryError>()("LiveQueryError", {
  code: Schema.Literals(["unauthorized", "unknownQuery", "invalidArguments", "failed"]),
}) {}

export class CoordinatorError extends Schema.TaggedError<CoordinatorError>()("CoordinatorError", {
  operation: Schema.Literals(["initialize", "read", "commit", "alarm", "socket"]),
}) {}

export interface HibernatingSocket {
  readonly serializeAttachment: (attachment: unknown) => void;
  readonly deserializeAttachment: () => unknown;
  readonly send: (message: string) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface DurableHost {
  readonly getWebSockets: () => ReadonlyArray<HibernatingSocket>;
  readonly setAlarm: (timestamp: number) => Promise<unknown>;
  readonly deleteAlarm: () => Promise<unknown>;
}

export interface DurableQueryResult {
  readonly value: Schema.Json;
  readonly tables: ReadonlyArray<string>;
}

export type LiveQueryResolver = (
  descriptor: SubscriptionDescriptor,
) => Effect.Effect<DurableQueryResult, LiveQueryError>;

export interface DurableCoordinator {
  readonly subscribe: (
    socket: HibernatingSocket,
    descriptor: SubscriptionDescriptor,
  ) => Effect.Effect<void, CoordinatorError>;
  readonly mutate: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CoordinatorError, R>;
  readonly recover: Effect.Effect<void, CoordinatorError>;
}
