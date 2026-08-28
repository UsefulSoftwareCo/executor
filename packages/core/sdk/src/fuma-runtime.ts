import { Cause, Context, Data, Effect, Exit, Layer, Predicate } from "effect";
import type { AbstractQuery } from "@executor-js/fumadb/query";
import type { AnySchema, AnyTable, Schema as FumaSchema } from "@executor-js/fumadb/schema";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class UniqueViolationError extends Data.TaggedError("UniqueViolationError")<{
  readonly model?: string;
}> {}

/**
 * The database connection itself failed — the statement never got a verdict.
 * Distinct from `StorageError` (a query the backend answered with an error)
 * because the two need different responses: a connection fault is either a
 * transient socket loss worth retrying on a FRESH pool, or a pool-lifetime
 * bug that must stay loud.
 *
 * `retryable` says which. It is a property of the fault, not a policy:
 *   - `true` — the socket died underneath a live pool, or was never
 *     established because the backend was unreachable (`CONNECTION_CLOSED`,
 *     `CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`). Reconnecting can
 *     succeed.
 *   - `false` — the pool was already torn down or the socket belongs to a
 *     different request context (`CONNECTION_ENDED`, `CONNECTION_DESTROYED`,
 *     the workerd cross-request I/O rejection). Retrying is futile by
 *     construction — postgres.js rejects every query once `end()` has been
 *     called — so these must surface rather than be papered over.
 *
 * No retry consumes this yet; classification lands first so the retry seam
 * (and the request-scope fix behind these faults) can be designed against a
 * typed signal instead of driver strings.
 */
export class StorageConnectionError extends Data.TaggedError("StorageConnectionError")<{
  readonly message: string;
  readonly label: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly cause: unknown;
}> {}

export type StorageFailure = StorageError | StorageConnectionError | UniqueViolationError;

export type FumaTables = Record<string, AnyTable>;
type EmptyFumaSchema = FumaSchema<"latest", Record<never, never>>;
export type TablesToFumaSchema<TTables extends FumaTables | undefined> = TTables extends FumaTables
  ? string extends keyof TTables
    ? AnySchema
    : FumaSchema<"latest", TTables>
  : EmptyFumaSchema;
export type FumaDb<TSchema extends AnySchema = AnySchema> = AbstractQuery<TSchema>;
export type FumaQuery<TSchema extends AnySchema = AnySchema> = Omit<
  AbstractQuery<TSchema>,
  "internal" | "withContext" | "transaction"
> & {
  readonly transaction: <A>(run: (db: FumaQuery<TSchema>) => Promise<A>) => Promise<A>;
};
export type FumaRow<TTable extends AnyTable> = Omit<
  {
    readonly [K in keyof TTable["columns"]]: TTable["columns"][K]["$out"];
  },
  "row_id"
>;

const isUniqueViolation = (cause: unknown): boolean => {
  let current = cause;
  for (let i = 0; i < 5; i += 1) {
    const err =
      current && typeof current === "object" ? (current as Record<string, unknown>) : null;
    if (!err) return false;
    const code = err["code"];
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: database drivers expose unique-violation details on native error messages
    const message = err["message"];
    const innerCause = err["cause"];
    if (code === "23505") return true;
    if (
      typeof message === "string" &&
      /unique constraint|duplicate key|violates unique constraint/i.test(message)
    ) {
      return true;
    }
    if (!innerCause || innerCause === current) return false;
    current = innerCause;
  }
  return false;
};

/**
 * postgres.js raises connection faults through `Errors.connection(code, …)`,
 * which puts the code on `error.code` (see `postgres/src/errors.js`). Workerd's
 * cross-request I/O rejection is a plain `Error` with no code, so it is matched
 * on its fixed runtime text and given a synthetic code.
 */
const RETRYABLE_CONNECTION_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_CLOSED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
]);
const FATAL_CONNECTION_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);
const CROSS_REQUEST_IO_CODE = "CROSS_REQUEST_IO";
const CROSS_REQUEST_IO_PATTERN = /cannot perform i\/o on behalf of a different request/i;

/** Walk a cause chain, newest first, at most 5 links deep (as `isUniqueViolation` does). */
const walkCauses = (cause: unknown, visit: (err: Record<string, unknown>) => boolean): boolean => {
  let current = cause;
  for (let i = 0; i < 5; i += 1) {
    const err =
      current && typeof current === "object" ? (current as Record<string, unknown>) : null;
    if (!err) return false;
    if (visit(err)) return true;
    const innerCause = err["cause"];
    if (!innerCause || innerCause === current) return false;
    current = innerCause;
  }
  return false;
};

/** First driver error code in the cause chain, if any. Never the error text. */
const causeCode = (cause: unknown): string | undefined => {
  let found: string | undefined;
  walkCauses(cause, (err) => {
    const code = err["code"];
    if (typeof code === "string" && code.length > 0) {
      found = code;
      return true;
    }
    return false;
  });
  return found;
};

/** Connection-fault code in the cause chain, if this is a connection fault at all. */
const connectionFaultCode = (cause: unknown): string | undefined => {
  let found: string | undefined;
  walkCauses(cause, (err) => {
    const code = err["code"];
    if (
      typeof code === "string" &&
      (RETRYABLE_CONNECTION_CODES.has(code) || FATAL_CONNECTION_CODES.has(code))
    ) {
      found = code;
      return true;
    }
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: workerd's cross-request I/O rejection carries no code, only this fixed message
    const message = err["message"];
    if (typeof message === "string" && CROSS_REQUEST_IO_PATTERN.test(message)) {
      found = CROSS_REQUEST_IO_CODE;
      return true;
    }
    return false;
  });
  return found;
};

/**
 * Build the failure message from stable inputs only — the call-site label and
 * the driver's error code — never the driver's text.
 *
 * The driver text is `Failed query: <sql>\nparams: <bound values>`
 * (`drizzle-orm/errors.js`). Copying it into the message made error reporting
 * group by statement shape, splitting one defect across a report per table and
 * WHERE-clause, and printed bound parameters (organization ids, user ids,
 * user-chosen connection names) into report titles. The full driver error is
 * preserved on `cause`, which the reporter still receives as a chained
 * exception.
 */
const stableMessage = (label: string, code: string | undefined): string =>
  code ? `FumaDB ${label} failed: ${code}` : `FumaDB ${label} failed`;

export const isStorageFailure = (error: unknown): error is StorageFailure =>
  Predicate.isTagged(error, "StorageError") ||
  Predicate.isTagged(error, "StorageConnectionError") ||
  Predicate.isTagged(error, "UniqueViolationError");

export const fumaFailureFromCause = (label: string, cause: unknown): StorageFailure => {
  if (isStorageFailure(cause)) return cause;
  if (isUniqueViolation(cause)) return new UniqueViolationError({ model: label });
  const connectionCode = connectionFaultCode(cause);
  if (connectionCode !== undefined) {
    return new StorageConnectionError({
      message: stableMessage(label, connectionCode),
      label,
      code: connectionCode,
      retryable: RETRYABLE_CONNECTION_CODES.has(connectionCode),
      cause,
    });
  }
  return new StorageError({
    message: stableMessage(label, causeCode(cause)),
    cause,
  });
};

export const fumaEffect = <A>(
  label: string,
  run: () => Promise<A>,
): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => fumaFailureFromCause(label, cause),
  });

export const activeFumaDbRef = Context.Reference<FumaDb | null>("executor/ActiveFumaDb", {
  defaultValue: () => null,
});

// Post-commit hooks. `transaction()` nests by pass-through (an inner
// `transaction()` call inside an active transaction just runs its effect), so
// an effect that must observe only DURABLE changes cannot simply run "after
// the transaction" — after an inner pass-through the outer transaction may
// still roll back. `afterCommit` solves this structurally: while a transaction
// is active the effect is queued on the outermost transaction's hook list and
// runs after its commit; with no active transaction it runs immediately.
// Hooks are best-effort observers: failures and defects are swallowed, and a
// rolled-back transaction discards its queue.
const pendingCommitHooksRef = Context.Reference<Array<Effect.Effect<void>> | null>(
  "executor/PendingCommitHooks",
  { defaultValue: () => null },
);

export const afterCommit = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.flatMap(Effect.service(pendingCommitHooksRef), (hooks) =>
    hooks
      ? Effect.sync(() => {
          hooks.push(effect);
        })
      : effect.pipe(Effect.ignoreCause({ log: false })),
  );

class TransactionEffectFailure {
  constructor(readonly error: unknown) {}
}

class TransactionEffectDefect {
  constructor(readonly cause: unknown) {}
}

export type IFumaClient<TSchema extends AnySchema = AnySchema> = Readonly<{
  use: <A>(
    label: string,
    fn: (db: FumaQuery<TSchema>) => Promise<A>,
  ) => Effect.Effect<A, StorageFailure>;
  transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
}>;

export interface MakeFumaClientOptions {
  readonly tables?: ReadonlySet<string>;
}

const isAllowedTable = (tables: ReadonlySet<string> | undefined, table: PropertyKey): boolean =>
  tables === undefined || (typeof table === "string" && tables.has(table));

const assertAllowedTable = (tables: ReadonlySet<string> | undefined, table: PropertyKey): void => {
  if (isAllowedTable(tables, table)) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plugin-facing FumaDB facade rejects unavailable tables synchronously before query execution
  throw new StorageError({
    message: `FumaDB table "${String(table)}" is not available through this storage boundary.`,
    cause: undefined,
  });
};

const makeSafeFumaQuery = <TSchema extends AnySchema>(
  db: FumaDb<TSchema>,
  options: MakeFumaClientOptions,
): FumaQuery<TSchema> => {
  const table = <TableName extends keyof TSchema["tables"]>(name: TableName): TableName => {
    assertAllowedTable(options.tables, name);
    return name;
  };

  const query: FumaQuery<TSchema> = {
    count: (name, value) => db.count(table(name), value),
    create: (name, value) => db.create(table(name), value),
    createMany: (name, values) => db.createMany(table(name), values),
    deleteMany: (name, value) => db.deleteMany(table(name), value),
    findFirst: (name, value) => db.findFirst(table(name), value),
    findMany: (name, value) => db.findMany(table(name), value),
    transaction: (run) =>
      db.transaction((transactionDb) => run(makeSafeFumaQuery(transactionDb, options))),
    updateMany: (name, value) => db.updateMany(table(name), value),
    upsert: (name, value) => db.upsert(table(name), value),
    upsertMany: (name, value) => db.upsertMany(table(name), value),
  };

  return Object.freeze(query);
};

export const makeFumaClient = (db: FumaDb, options: MakeFumaClientOptions = {}): IFumaClient => {
  const use: IFumaClient["use"] = (label, fn) =>
    Effect.flatMap(Effect.service(activeFumaDbRef), (active) =>
      fumaEffect(label, () => fn(makeSafeFumaQuery(active ?? db, options))),
    ).pipe(Effect.withSpan(`fumadb.${label}`));

  const transaction = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | StorageFailure> =>
    Effect.flatMap(Effect.service(activeFumaDbRef), (active) => {
      if (active) return effect as Effect.Effect<unknown, unknown>;

      // The outermost transaction owns the post-commit hook queue; hooks
      // queued anywhere inside (including nested pass-through transactions)
      // run only after THIS commit, and are discarded on rollback.
      const commitHooks: Array<Effect.Effect<void>> = [];
      return Effect.tryPromise({
        try: () =>
          db.transaction(async (transactionDb) => {
            const exit = await Effect.runPromiseExit(
              effect.pipe(
                Effect.provideService(activeFumaDbRef, transactionDb),
                Effect.provideService(pendingCommitHooksRef, commitHooks),
              ),
            );
            if (Exit.isSuccess(exit)) return exit.value;

            const failure = exit.cause.reasons.find(Cause.isFailReason);
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB transactions roll back when the callback rejects
            if (failure) throw new TransactionEffectFailure(failure.error);
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: FumaDB transactions roll back when the callback rejects
            throw new TransactionEffectDefect(exit.cause);
          }),
        catch: (cause): E | StorageFailure => {
          if (cause instanceof TransactionEffectFailure) return cause.error as E;
          if (cause instanceof TransactionEffectDefect) {
            return fumaFailureFromCause("transaction", cause.cause);
          }
          return fumaFailureFromCause("transaction", cause);
        },
      }).pipe(
        Effect.tap(() =>
          Effect.forEach(commitHooks, (hook) => hook.pipe(Effect.ignoreCause({ log: false })), {
            discard: true,
          }),
        ),
      );
    }).pipe(Effect.withSpan("fumadb.transaction")) as Effect.Effect<A, E | StorageFailure>;

  return { use, transaction };
};

export class FumaClient extends Context.Service<FumaClient, IFumaClient>()("executor/FumaClient") {
  static layer = (db: FumaDb) => Layer.succeed(this)(makeFumaClient(db));
}
