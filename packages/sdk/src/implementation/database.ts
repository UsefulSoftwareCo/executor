/** Native Effect database operations; SQL failures are projected to safe domain errors. */
import { Effect } from "effect";
import { StorageError } from "../contracts/shared.ts";
import type { ExecutorDatabase } from "./storage.ts";

/** Bound query handle sharing the host connection and reactive transaction context. */
export type Query = ReturnType<typeof database>;
/** Select the latest migrated storage schema. */
export const database = (storage: ExecutorDatabase) => storage.orm("3.0.0");
/** Run a lazy native query without leaking SQL or driver details. */
export const query = <A, E, R>(work: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(work).pipe(
    Effect.withSpan("storage.query"),
    Effect.mapError(() => new StorageError()),
  );
/** Preserve native Effect failures and cancellation through the SQL transaction. */
export const transaction = <A, E, R>(db: Query, work: (tx: Query) => Effect.Effect<A, E, R>) =>
  db.transaction(Effect.suspend(() => work(db))).pipe(
    Effect.withSpan("storage.transaction"),
    Effect.catchTag("SqlError", () => new StorageError()),
  );
