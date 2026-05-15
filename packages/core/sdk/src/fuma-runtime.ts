import { Cause, Context, Data, Effect, Exit, Layer, Predicate } from "effect";
import type { AbstractQuery } from "fumadb/query";
import type { AnySchema, AnyTable, Schema as FumaSchema } from "fumadb/schema";

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class UniqueViolationError extends Data.TaggedError("UniqueViolationError")<{
  readonly model?: string;
}> {}

export type StorageFailure = StorageError | UniqueViolationError;

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

const causeMessage = (cause: unknown): string | undefined => {
  const message =
    cause && typeof cause === "object"
      ? // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: preserve database driver error text inside typed StorageError
        (cause as Record<string, unknown>)["message"]
      : undefined;
  return typeof message === "string" && message.length > 0 ? message : undefined;
};

export const isStorageFailure = (error: unknown): error is StorageFailure =>
  Predicate.isTagged(error, "StorageError") || Predicate.isTagged(error, "UniqueViolationError");

export const fumaFailureFromCause = (label: string, cause: unknown): StorageFailure => {
  if (isStorageFailure(cause)) return cause;
  if (isUniqueViolation(cause)) return new UniqueViolationError({ model: label });
  return new StorageError({
    message: causeMessage(cause) ?? `FumaDB operation failed: ${label}`,
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

      return Effect.tryPromise({
        try: () =>
          db.transaction(async (transactionDb) => {
            const exit = await Effect.runPromiseExit(
              effect.pipe(Effect.provideService(activeFumaDbRef, transactionDb)),
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
      });
    }).pipe(Effect.withSpan("fumadb.transaction")) as Effect.Effect<A, E | StorageFailure>;

  return { use, transaction };
};

export class FumaClient extends Context.Service<FumaClient, IFumaClient>()("executor/FumaClient") {
  static layer = (db: FumaDb) => Layer.succeed(this)(makeFumaClient(db));
}
