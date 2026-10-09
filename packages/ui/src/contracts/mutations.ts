import { Effect, Option, type Cause } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

/**
 * Publish server-confirmed changes before a mutation completes. Refresh failures
 * retain that confirmed value alongside the typed read error; a later successful
 * read replaces it. Writes patch existing data only, never fabricate a record.
 * Products may discard previous data on an authoritative access-denied failure.
 */
export const acknowledgedQuery = <A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  retainFailure?: (cause: Cause.Cause<E>) => boolean,
) => {
  const query: Atom.Writable<
    AsyncResult.AsyncResult<A, E>,
    ((current: A) => A) | undefined
  > = Atom.writable(
    (get) => {
      const result = get(source);
      const previous = get.self<AsyncResult.AsyncResult<A, E>>();
      if (AsyncResult.isFailure(result))
        return retainFailure?.(result.cause) === false
          ? AsyncResult.failure<A, E>(result.cause, { waiting: result.waiting })
          : AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting });
      if (result.waiting && Option.isSome(previous)) return AsyncResult.waiting(previous.value);
      return result;
    },
    (get, update) => {
      // A view may not have read this query yet. Establish its source dependency before writing.
      const result = get.get(query);
      if (update === undefined) {
        get.setSelf(AsyncResult.initial(true));
        return;
      }
      const current = AsyncResult.value(result);
      if (Option.isSome(current)) get.setSelf(AsyncResult.success(update(current.value)));
    },
    (refresh) => refresh(source),
  );
  return query;
};

/** Apply a successful response to all shared readers before starting reconciliation. */
export const acknowledge = <A, E>(
  get: { readonly registry: AtomRegistry.AtomRegistry },
  query: Atom.Writable<AsyncResult.AsyncResult<A, E>, (current: A) => A>,
  update: (current: A) => A,
): void => {
  get.registry.set(query, update);
  get.registry.refresh(query);
};

/** Wait until the query has no read in flight. */
const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!registry.get(query).waiting) {
      resume(Effect.void);
      return;
    }
    const cancel = registry.subscribe(query, (result) => {
      if (result.waiting) return;
      cancel();
      resume(Effect.void);
    });
    return Effect.sync(cancel);
  });

/**
 * Read a query's data for a mutation and publish it when no other read could be newer: the query had
 * no read in flight and did not change while this one ran. Otherwise wait for the query to settle and
 * read again. A failed read leaves the query as it was, so only the mutation reports it.
 */
export const readInto = <A, E, ReadError, R>(
  get: { readonly registry: AtomRegistry.AtomRegistry },
  query: Atom.Writable<AsyncResult.AsyncResult<A, E>, (current: A) => A>,
  read: Effect.Effect<A, ReadError, R>,
): Effect.Effect<A, ReadError, R> =>
  Effect.acquireUseRelease(
    // A mounted query cannot be disposed and start a read of its own between attempts.
    Effect.sync(() => get.registry.mount(query)),
    () =>
      Effect.gen(function* () {
        while (true) {
          let quiet = !get.registry.get(query).waiting;
          const value = yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              get.registry.subscribe(query, () => {
                quiet = false;
              }),
            ),
            () => read,
            (cancel) => Effect.sync(cancel),
          );
          if (quiet) {
            get.registry.set(query, () => value);
            return value;
          }
          yield* settled(get.registry, query);
        }
      }),
    (unmount) => Effect.sync(unmount),
  );

/** A successful write changed data absent from its response; clear stale display data. */
export const invalidate = <A, E>(
  get: { readonly registry: AtomRegistry.AtomRegistry },
  query: Atom.Writable<AsyncResult.AsyncResult<A, E>, undefined>,
): void => {
  get.registry.set(query, undefined);
  get.registry.refresh(query);
};

/** Derived data cannot reuse success during refresh; a known failure stays visible while retrying. */
export const currentQuery = <A, E>(source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Atom.map(source, (result) =>
    AsyncResult.isFailure(result)
      ? AsyncResult.failure<A, E>(result.cause, { waiting: result.waiting })
      : result.waiting
        ? AsyncResult.initial<A, E>(true)
        : result,
  );

/** Reconcile one server record without moving an existing row in its list. */
export const upsert = <A extends { readonly id: string }>(
  rows: readonly A[],
  saved: A,
): readonly A[] =>
  rows.some((row) => row.id === saved.id)
    ? rows.map((row) => (row.id === saved.id ? saved : row))
    : [...rows, saved];
