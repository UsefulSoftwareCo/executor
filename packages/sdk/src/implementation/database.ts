/** Native Effect database operations; SQL failures are projected to safe domain errors. */
import { Effect, Result } from "effect";
import { SqlError } from "effect/sql";
import { failureAttributes, withFailureAttributes } from "@executor-js/telemetry/failed-span";
import { StorageError } from "../contracts/shared.ts";
import type { ExecutorDatabase } from "./storage.ts";

/** Bound query handle sharing the host connection and reactive transaction context. */
export type Query = ReturnType<typeof database>;
/** Select the latest migrated storage schema. */
export const database = (storage: ExecutorDatabase) => storage.orm("4.0.17");
/**
 * Run a lazy native query without leaking SQL or driver details. The query's own
 * `sql.execute` spans cover the same interval, so this boundary adds no span of its own.
 */
export const query = <A, E, R>(work: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(work).pipe(
    // A span that records the failure still names the statement and the database's kind of failure.
    Effect.mapError((error) => withFailureAttributes(new StorageError(), failureAttributes(error))),
  );
/** Preserve native Effect failures and cancellation through the SQL transaction. */
export const transaction = <A, E, R>(db: Query, work: (tx: Query) => Effect.Effect<A, E, R>) =>
  db.transaction(Effect.suspend(() => work(db))).pipe(
    Effect.withSpan("storage.transaction"),
    Effect.catchTag("SqlError", (error) =>
      // A statement inside it that failed outside `query` names itself; otherwise the transaction does.
      withFailureAttributes(new StorageError(), {
        "executor.storage.operation": "transaction",
        ...(SqlError.isSqlError(error) && { "executor.storage.reason": error.reason._tag }),
        ...failureAttributes(error),
      }),
    ),
  );
/**
 * Run two effects at once but report the first one's failure first, as if they ran in order. Read
 * ahead of a check this way only: the second's result is released only once the first succeeded.
 */
export const inOrder = <A, B, E1, E2, R1, R2>(
  first: Effect.Effect<A, E1, R1>,
  second: Effect.Effect<B, E2, R2>,
) =>
  Effect.all([Effect.result(first), Effect.result(second)], { concurrency: "unbounded" }).pipe(
    Effect.flatMap(([a, b]) =>
      Result.isFailure(a)
        ? Effect.fail<E1 | E2>(a.failure)
        : Result.isFailure(b)
          ? Effect.fail<E1 | E2>(b.failure)
          : Effect.succeed([a.success, b.success] as const),
    ),
  );
