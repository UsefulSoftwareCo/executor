import { Cause, Effect, Exit, Predicate } from "effect";

import type { McpConnection, McpConnector } from "./connection";
import type { McpInvocationError } from "./errors";

const IDLE_TTL_MS = 5 * 60 * 1_000;

type IdleConnection = {
  readonly connection: McpConnection;
  readonly idleSince: number;
};

type ConnectionLease = {
  readonly connection: McpConnection;
  readonly reused: boolean;
};

const closeQuietly = (connection: McpConnection): Effect.Effect<void> =>
  Effect.tryPromise(() => connection.close()).pipe(Effect.ignore);

const isMcpInvocationError = (error: unknown): error is McpInvocationError =>
  Predicate.isTagged(error, "McpInvocationError");

const isDeadConnectionFailure = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "McpConnectionError")) return true;
  if (!isMcpInvocationError(error)) return false;
  return (
    error.transportFailure === true ||
    error.status === 400 ||
    error.status === 404 ||
    error.status === 408
  );
};

const shouldDropConnection = <A, E>(exit: Exit.Exit<A, E>): boolean => {
  if (Exit.isSuccess(exit)) return false;
  const failures = exit.cause.reasons.filter(Cause.isFailReason);
  if (failures.length === 0) return true;
  return failures.some((failure) => isDeadConnectionFailure(failure.error));
};

/** A per-plugin-instance pool that gives each invocation an exclusive MCP
 * connection lease while retaining at most one idle session per identity. */
export interface McpConnectionPool {
  readonly withConnection: <A, E, R>(
    key: string,
    connector: McpConnector,
    use: (connection: McpConnection) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Effect.Error<McpConnector>, R>;
  /** Closes and removes every currently idle connection. Leased connections
   * remain owned by their in-flight invocation and follow normal release. */
  readonly close: () => Effect.Effect<void>;
}

/** Creates an MCP connection pool with lazy five-minute idle eviction and one
 * automatic fresh-dial retry for a reused session rejected with HTTP 404. */
export const createMcpConnectionPool = (): McpConnectionPool => {
  const idle = new Map<string, IdleConnection>();

  const acquire = (key: string, connector: McpConnector, forceFresh: boolean) =>
    Effect.gen(function* () {
      if (forceFresh) {
        const connection = yield* connector;
        return { connection, reused: false } satisfies ConnectionLease;
      }

      const taken = yield* Effect.sync(() => {
        const entry = idle.get(key);
        if (!entry) return { connection: undefined, expired: undefined };
        idle.delete(key);
        if (Date.now() - entry.idleSince >= IDLE_TTL_MS) {
          return { connection: undefined, expired: entry.connection };
        }
        return { connection: entry.connection, expired: undefined };
      });

      if (taken.expired) yield* closeQuietly(taken.expired);
      if (taken.connection) {
        return { connection: taken.connection, reused: true } satisfies ConnectionLease;
      }

      const connection = yield* connector;
      return { connection, reused: false } satisfies ConnectionLease;
    });

  const release = <A, E>(key: string, lease: ConnectionLease, exit: Exit.Exit<A, E>) =>
    Effect.gen(function* () {
      if (shouldDropConnection(exit)) {
        yield* closeQuietly(lease.connection);
        return;
      }

      const displaced = yield* Effect.sync(() => {
        if (idle.has(key)) return lease.connection;
        idle.set(key, { connection: lease.connection, idleSince: Date.now() });
        return undefined;
      });
      if (displaced) yield* closeQuietly(displaced);
    });

  const withConnection: McpConnectionPool["withConnection"] = (key, connector, use) => {
    let reused = false;
    const run = (forceFresh: boolean) =>
      Effect.acquireUseRelease(
        acquire(key, connector, forceFresh),
        (lease) => {
          if (!forceFresh) reused = lease.reused;
          return use(lease.connection);
        },
        (lease, exit) => release(key, lease, exit),
      );

    return run(false).pipe(
      Effect.catch((error) =>
        reused && isMcpInvocationError(error) && error.status === 404
          ? run(true)
          : Effect.fail(error),
      ),
    );
  };

  const close = () =>
    Effect.gen(function* () {
      const connections = yield* Effect.sync(() => {
        const connections = [...idle.values()].map((entry) => entry.connection);
        idle.clear();
        return connections;
      });
      yield* Effect.forEach(connections, closeQuietly, {
        concurrency: "unbounded",
        discard: true,
      });
    });

  return { withConnection, close };
};
