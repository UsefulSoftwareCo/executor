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

export type PagedListEnd<E> =
  | { readonly status: "complete" }
  | { readonly status: "more" }
  | { readonly status: "loading" }
  | {
      readonly status: "failed";
      readonly cause: Cause.Cause<E>;
      readonly page: Atom.Atom<unknown>;
    };

export interface PagedListState<A, E> {
  readonly first: AsyncResult.AsyncResult<ListPage<A>, E>;
  readonly rows: ReadonlyArray<A>;
  readonly lookback: string | null;
  readonly end: PagedListEnd<E>;
  readonly extraPages: number;
}

export interface PagedList<A, E> {
  readonly first: PageAtom<A, E>;
  readonly state: Atom.Atom<PagedListState<A, E>>;
  readonly requested: Atom.Writable<number>;
}

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
