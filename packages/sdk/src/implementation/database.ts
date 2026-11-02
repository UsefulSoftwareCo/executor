/** Native Effect database operations; SQL failures are projected to safe domain errors. */
import { Effect } from "effect";
import { SqlError } from "effect/sql";
import { failureAttributes, withFailureAttributes } from "@executor-js/telemetry/failed-span";
import { StorageError } from "../contracts/shared.ts";
import type { ExecutorDatabase } from "./storage.ts";

/** Bound query handle sharing the host connection and reactive transaction context. */
export type Query = ReturnType<typeof database>;
/** Select the latest migrated storage schema. */
export const database = (storage: ExecutorDatabase) => storage.orm("4.0.23");
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
