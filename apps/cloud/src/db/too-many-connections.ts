// ---------------------------------------------------------------------------
// Retry a direct Postgres call while the server refuses new connections.
//
// The deploy's out-of-band scripts (`scripts/migrate.ts`,
// `scripts/ensure-workos-mirror-ready.ts`, and the backfill and drain scripts
// it spawns) each open ONE direct connection to production Postgres. Those
// connections compete for the server's non-superuser slots with Hyperdrive's
// pools (through PSBouncer), operator sessions, and other CI jobs. When no
// slot is free the server answers the connect with SQLSTATE 53300
// (`too_many_connections`, "remaining connection slots are reserved for roles
// with the SUPERUSER attribute") before a single statement runs. On
// 2026-09-18 two consecutive migration attempts nine minutes apart were
// refused that way after Worker redeploys; a rerun about an hour later
// passed. So that specific refusal is retried on a fixed cadence for about
// fifteen minutes, which lets the deploy wait for a slot instead of failing;
// every other failure (a bad migration, a lost network) surfaces unchanged on
// the first attempt. This is a mitigation for the transient refusal, not the
// capacity fix — that is the server's connection ceiling and the pool sizes
// in front of it.
// ---------------------------------------------------------------------------

import { Effect, Result, Schedule } from "effect";
import type postgres from "postgres";

/** SQLSTATE `too_many_connections`: the server's connection ceiling is reached. */
export const TOO_MANY_CONNECTIONS_SQLSTATE = "53300";

// postgres.js sets the SQLSTATE as a string `code`; Drizzle wraps that in its
// own "Failed query" error with the driver error in `.cause`. Walk the chain
// (bounded) rather than inspect one level.
const MAX_CAUSE_DEPTH = 8;

export const isTooManyConnectionsError = (failure: unknown): boolean => {
  let current: unknown = failure;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
    depth++
  ) {
    if ((current as { readonly code?: unknown }).code === TOO_MANY_CONNECTIONS_SQLSTATE) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
};

/**
 * 30 retries, 30 seconds apart: about fifteen minutes of waiting for a slot,
 * longer than the nine minutes the two refusals of 2026-09-18 spanned.
 */
export const TOO_MANY_CONNECTIONS_RETRIES = 30;
export const TOO_MANY_CONNECTIONS_RETRY_INTERVAL = "30 seconds";

export const TOO_MANY_CONNECTIONS_RETRY_SCHEDULE = Schedule.both(
  Schedule.spaced(TOO_MANY_CONNECTIONS_RETRY_INTERVAL),
  Schedule.recurs(TOO_MANY_CONNECTIONS_RETRIES),
);

export type RetryTooManyConnectionsOptions = {
  /** Overrides the production cadence; tests pass a delay-free schedule. */
  readonly schedule?: Schedule.Schedule<unknown, unknown>;
  /** Called on every refused attempt (including the last), before the wait. */
  readonly onRefused?: (failure: unknown, attempt: number) => void;
};

/** One log line per refused attempt, for the script's own logger. */
export const describeRefusedAttempt = (attempt: number): string =>
  `Postgres refused the connection: no free connection slots (attempt ${attempt} of ${TOO_MANY_CONNECTIONS_RETRIES + 1}); ` +
  (attempt > TOO_MANY_CONNECTIONS_RETRIES
    ? "giving up"
    : `retrying in ${TOO_MANY_CONNECTIONS_RETRY_INTERVAL}`);

/**
 * Run `attempt`, retrying only while it fails with SQLSTATE 53300; any other
 * failure ends the loop on the spot. Fails with the ORIGINAL error — the
 * non-53300 failure from the attempt that raised it, or the last refusal once
 * the schedule is spent.
 */
export const retryTooManyConnections = <A, E>(
  attempt: Effect.Effect<A, E>,
  options: RetryTooManyConnectionsOptions = {},
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    let refusals = 0;
    const observed = Effect.tapError(attempt, (failure) =>
      Effect.sync(() => {
        if (!isTooManyConnectionsError(failure)) return;
        refusals += 1;
        options.onRefused?.(failure, refusals);
      }),
    );
    return Effect.retry(observed, {
      schedule: options.schedule ?? TOO_MANY_CONNECTIONS_RETRY_SCHEDULE,
      while: isTooManyConnectionsError,
    });
  });

/**
 * {@link retryTooManyConnections} over a Promise, for the scripts that work in
 * raw driver promises. Never rejects: resolves with the first success, or with
 * the original failure for the calling script to rethrow at its boundary.
 */
export const retryWhileTooManyConnections = <A>(
  run: () => Promise<A>,
  options: RetryTooManyConnectionsOptions = {},
): Promise<Result.Result<A, unknown>> =>
  Effect.runPromise(
    retryTooManyConnections(Effect.tryPromise({ try: run, catch: (cause) => cause }), options).pipe(
      Effect.result,
    ),
  );

/**
 * Open `sql`'s one connection, waiting for a slot: a `SELECT 1` retried while
 * 53300. postgres.js keeps that connection (no idle timeout by default) for
 * every statement that follows, so a script whose database failures are
 * classified at a service boundary — `WorkOsMirrorError` drops the driver
 * cause, see `auth/errors.ts` — gets the same wait as one that sees the raw
 * driver error. This guards the connect, which is where 53300 is raised; a
 * connection dropped and reopened mid-run is not guarded.
 */
export const waitForConnectionSlot = (
  sql: postgres.Sql,
  options: RetryTooManyConnectionsOptions = {},
): Effect.Effect<void, unknown> =>
  retryTooManyConnections(
    Effect.tryPromise({
      try: async () => {
        await sql`select 1`;
      },
      catch: (cause) => cause,
    }),
    options,
  );
