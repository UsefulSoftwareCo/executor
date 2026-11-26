import { Effect, Result } from "effect";
import { SqlError } from "effect/sql";
import { failureAttributes, withFailureAttributes } from "@executor-js/telemetry/failed-span";
import { StorageError } from "../contracts/shared.ts";
import type { ExecutorDatabase } from "./storage.ts";

export type Query = ReturnType<typeof database>;
export const database = (storage: ExecutorDatabase) => storage.orm("4.0.19");
export const query = <A, E, R>(work: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(work).pipe(
    Effect.mapError((error) => withFailureAttributes(new StorageError(), failureAttributes(error))),
  );
export const transaction = <A, E, R>(db: Query, work: (tx: Query) => Effect.Effect<A, E, R>) =>
  db.transaction(Effect.suspend(() => work(db))).pipe(
    Effect.withSpan("storage.transaction"),
    Effect.catchTag("SqlError", (error) =>
      withFailureAttributes(new StorageError(), {
        "executor.storage.operation": "transaction",
        ...(SqlError.isSqlError(error) && { "executor.storage.reason": error.reason._tag }),
        ...failureAttributes(error),
      }),
    ),
  );
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
