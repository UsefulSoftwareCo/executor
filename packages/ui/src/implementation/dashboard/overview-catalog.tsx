import { useMemo, type ComponentType, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { OverviewCardLoading } from "./app-loading.tsx";

/** Summarize live catalogs once by name; execution stays in the account-specific tabs. */
export function OverviewCatalog<A, E, Item extends { readonly name: string }>({
  sources,
  items,
  children,
  empty,
  label,
  Failure,
}: {
  readonly sources: readonly { readonly key: string; readonly query: Query<A, E> }[];
  readonly items: (value: A) => readonly Item[];
  readonly children: (entries: readonly Item[]) => ReactNode;
  readonly empty: ReactNode;
  readonly label: string;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const snapshot = useMemo(
    () =>
      Atom.make((get) =>
        sources.map(({ key, query }) => ({
          key,
          result: get(query),
          retry: () => get.registry.refresh(query),
        })),
      ),
    [sources],
  );
  const results = useAtomValue(snapshot);
  const entries = new Map<string, Item>();
  for (const { result } of results) {
    const value = AsyncResult.value(result);
    if (Option.isSome(value))
      for (const item of items(value.value))
        if (!entries.has(item.name)) entries.set(item.name, item);
  }
  const loading = results.some(({ result }) => AsyncResult.isInitial(result));
  const failed = results.some(({ result }) => AsyncResult.isFailure(result));
  return (
    <>
      {results.map(({ key, result, retry }) =>
        AsyncResult.isFailure(result) ? (
          <Failure key={key} cause={result.cause} retry={retry} />
        ) : null,
      )}
      {entries.size > 0 ? (
        children([...entries.values()].sort((a, b) => a.name.localeCompare(b.name)))
      ) : loading ? (
        <OverviewCardLoading label={label} />
      ) : failed ? null : (
        empty
      )}
    </>
  );
}
