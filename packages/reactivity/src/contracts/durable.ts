import { Schema, type Effect } from "effect";
import type { SubscriptionDescriptor } from "./store.ts";

/** Safe protocol failure; query implementations never return credentials in it. */
export class LiveQueryError extends Schema.TaggedError<LiveQueryError>()("LiveQueryError", {
  code: Schema.Literals(["unauthorized", "unknownQuery", "invalidArguments", "failed"]),
}) {}

/** Host coordination failure. Details stay in the server's error channel. */
export class CoordinatorError extends Schema.TaggedError<CoordinatorError>()("CoordinatorError", {
  operation: Schema.Literals(["initialize", "read", "commit", "alarm", "socket"]),
}) {}

/** Minimal hibernating WebSocket operations supplied by Cloudflare at the edge. */
export interface HibernatingSocket {
  readonly serializeAttachment: (attachment: unknown) => void;
  readonly deserializeAttachment: () => unknown;
  readonly send: (message: string) => void;
  readonly close: (code: number, reason: string) => void;
}

/** Platform I/O only; the coordinator uses Effect internally. */
export interface DurableHost {
  readonly getWebSockets: () => ReadonlyArray<HibernatingSocket>;
  readonly setAlarm: (timestamp: number) => Promise<unknown>;
  readonly deleteAlarm: () => Promise<unknown>;
}

/** One read-only evaluation under freshly checked caller authorization. */
export interface DurableQueryResult {
  readonly value: Schema.Json;
  readonly tables: ReadonlyArray<string>;
}

/**
 * Stable query IDs resolve through this host-owned registry after every wake.
 * Resolve arguments and authorization anew, then run through tracked storage.
 */
export type LiveQueryResolver = (
  descriptor: SubscriptionDescriptor,
) => Effect.Effect<DurableQueryResult, LiveQueryError>;

/** SQL-backed coordinator for one Durable Object's data and hibernating sockets. */
export interface DurableCoordinator {
  /**
   * Attach a server-authenticated caller to an already accepted socket. The
   * descriptor must not come directly from an untrusted client: caller and
   * namespace belong to the host. Sends an initial full snapshot.
   */
  readonly subscribe: (
    socket: HibernatingSocket,
    descriptor: SubscriptionDescriptor,
  ) => Effect.Effect<void, CoordinatorError>;
  /**
   * Commit data and table revisions together, then deliver snapshots. Scheduling
   * happens before commit so a crash after commit cannot lose the wake-up.
   * Nested calls use SQL savepoints and collect keys into the outer commit.
   * Pass [] to wrap a transaction whose instrumented writes supply their keys.
   */
  readonly mutate: <A, E, R>(
    tables: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CoordinatorError, R>;
  /** Call from the Durable Object alarm handler and once after construction. */
  readonly recover: Effect.Effect<void, CoordinatorError>;
}
