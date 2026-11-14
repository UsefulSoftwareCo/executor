/**
 * A list the collector returns a page at a time. The first page is an ordinary query atom; each
 * "Load more" adds the page after the last one shown, read with that page's `nextCursor`. Pages
 * already shown stay mounted, so loading another neither requests nor reorders them.
 */
import { AsyncResult, Atom } from "effect/reactivity";
import type { Cause } from "effect";

export interface ListPage<A> {
  readonly data: ReadonlyArray<A>;
  readonly meta: {
    readonly lookback: string;
    readonly truncated: boolean;
    readonly nextCursor: string | null;
  };
}

type PageAtom<A, E> = Atom.Atom<AsyncResult.AsyncResult<ListPage<A>, E>>;

/** What follows the rows shown. */
export type PagedListEnd<E> =
  | { readonly status: "complete" }
  | { readonly status: "more" }
  | { readonly status: "loading" }
  | {
      readonly status: "failed";
      readonly cause: Cause.Cause<E>;
      /** The page that failed; refresh it to try again. */
      readonly page: Atom.Atom<unknown>;
    };

export interface PagedListState<A, E> {
  /** The first page's result. Until it succeeds there are no rows to show. */
  readonly first: AsyncResult.AsyncResult<ListPage<A>, E>;
  readonly rows: ReadonlyArray<A>;
  /** The time window the collector applied, such as `1h`. */
  readonly lookback: string | null;
  readonly end: PagedListEnd<E>;
  /** How many pages after the first are shown. */
  readonly extraPages: number;
}

export interface PagedList<A, E> {
  /** The first page. Refreshing it starts the list again from the newest rows. */
  readonly first: PageAtom<A, E>;
  readonly state: Atom.Atom<PagedListState<A, E>>;
  /** The number of pages after the first that the viewer asked for. */
  readonly requested: Atom.Writable<number>;
}

/**
 * Build the paged list for one query. Make a new one whenever the query's filters change, so a
 * page still loading for the old filters is dropped with its atom.
 */
export const pagedList = <A, E>(
  first: PageAtom<A, E>,
  next: (cursor: string) => PageAtom<A, E>,
  key: (row: A) => string,
): PagedList<A, E> => {
  const requested = Atom.make(0);
  const state = Atom.make((get): PagedListState<A, E> => {
    const firstResult = get(first);
    if (!AsyncResult.isSuccess(firstResult))
      return {
        first: firstResult,
        rows: [],
        lookback: null,
        end: { status: "loading" },
        extraPages: 0,
      };

    const wanted = get(requested);
    const seen = new Set<string>();
    const rows: A[] = [];
    // A summary that changed between two reads can come back on a later page too; show it once.
    const append = (page: ListPage<A>) => {
      for (const row of page.data) {
        const id = key(row);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    };

    const lookback = firstResult.value.meta.lookback;
    const done = (end: PagedListEnd<E>, extraPages: number): PagedListState<A, E> => ({
      first: firstResult,
      rows,
      lookback,
      end,
      extraPages,
    });

    let page = firstResult.value;
    append(page);
    let extraPages = 0;
    while (true) {
      if (!page.meta.truncated || page.meta.nextCursor === null)
        return done({ status: "complete" }, extraPages);
      if (extraPages >= wanted) return done({ status: "more" }, extraPages);
      const nextAtom = next(page.meta.nextCursor);
      const result = get(nextAtom);
      if (AsyncResult.isFailure(result) && !result.waiting)
        return done({ status: "failed", cause: result.cause, page: nextAtom }, extraPages);
      if (!AsyncResult.isSuccess(result)) return done({ status: "loading" }, extraPages);
      page = result.value;
      append(page);
      extraPages += 1;
    }
  });
  return { first, state, requested };
};
