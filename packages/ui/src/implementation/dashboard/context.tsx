import { createContext, useContext, type ReactNode } from "react";
import { RegistryContext, useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { type Cause, Option } from "effect";
import { Skeleton } from "../components/skeleton.tsx";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { DashboardBindings, Query, QueryProps } from "../../contracts/dashboard.ts";

const Context = createContext<DashboardBindings | null>(null);
export function DashboardProvider({
  children,
  ...bindings
}: DashboardBindings & { readonly children: ReactNode }) {
  return <Context value={bindings}>{children}</Context>;
}
export function useDashboard() {
  const value = useContext(Context);
  if (value === null) throw new Error("DashboardProvider must enclose this page");
  return value;
}
export const useOptionalDashboard = () => useContext(Context);
export function useQuery<A, E>(atom: Query<A, E>) {
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return { result, data: AsyncResult.value(result), refresh };
}

export function QueryView<A, E>({
  query,
  Failure,
  children,
  pending = <LoadingRows />,
}: QueryProps<A, E> & {
  readonly children: (value: A) => ReactNode;
  readonly pending?: ReactNode;
}) {
  const { result, refresh } = useQuery(query);
  return (
    <QueryResult result={result} Failure={Failure} retry={refresh} pending={pending}>
      {children}
    </QueryResult>
  );
}

type Results = Readonly<Record<string, AsyncResult.AsyncResult<unknown, unknown>>>;

export const allResults = <const R extends Results>(
  results: R,
): AsyncResult.AsyncResult<
  { readonly [K in keyof R]: AsyncResult.AsyncResult.Success<R[K]> },
  AsyncResult.AsyncResult.Failure<R[keyof R]>
> => {
  const entries = Object.entries(results);
  const waiting = entries.some(([, result]) => result.waiting);
  const values = entries.flatMap(([key, result]) =>
    Option.match(AsyncResult.value(result), {
      onNone: () => [],
      onSome: (value) => [[key, value] as const],
    }),
  );
  const value =
    values.length === entries.length
      ? Option.some(
          Object.fromEntries(values) as {
            readonly [K in keyof R]: AsyncResult.AsyncResult.Success<R[K]>;
          },
        )
      : Option.none();
  const failed = entries.find(([, result]) => AsyncResult.isFailure(result));
  if (failed !== undefined && AsyncResult.isFailure(failed[1]))
    return AsyncResult.failure(
      failed[1].cause as Cause.Cause<AsyncResult.AsyncResult.Failure<R[keyof R]>>,
      {
        previousSuccess: Option.map(value, (current) => AsyncResult.success(current)),
        waiting,
      },
    );
  return Option.match(value, {
    onNone: () => AsyncResult.initial(waiting),
    onSome: (current) => AsyncResult.success(current, { waiting }),
  });
};

export function QueryResult<A, E>({
  result,
  Failure,
  retry,
  children,
  pending = <LoadingRows />,
}: Omit<QueryProps<A, E>, "query"> & {
  readonly result: AsyncResult.AsyncResult<A, E>;
  readonly retry: () => void;
  readonly children: (value: A) => ReactNode;
  readonly pending?: ReactNode;
}) {
  const view = AsyncResult.match(result, {
    onInitial: () => ({ error: null, content: pending }),
    onSuccess: ({ value }) => ({ error: null, content: children(value) }),
    onFailure: (failure) => ({
      error: <Failure cause={failure.cause} retry={retry} retrying={failure.waiting} />,
      content: Option.match(AsyncResult.value(failure), {
        onNone: () => null,
        onSome: children,
      }),
    }),
  });
  return (
    <>
      {view.error}
      {view.content}
    </>
  );
}

export function LoadingRows({ count = 5 }: { readonly count?: number }) {
  return (
    <div
      className="loading-rows border border-border rounded-[8px] overflow-hidden min-h-90 [&_>_div]:flex [&_>_div]:items-center [&_>_div]:py-[22px] [&_>_div]:px-[18px] [&_>_div]:gap-3.75 [&_>_div]:border-b [&_>_div]:border-b-border [&_[data-slot='skeleton']]:block [&_[data-slot='skeleton']]:bg-accent [&_[data-slot='skeleton']]:rounded-[5px]"
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <Skeleton className="skeleton-icon w-8.5 h-8.5 max-[740px]:shrink-0" />
          <Skeleton className="skeleton-copy w-45 h-3.25 max-[740px]:min-w-0" />
          <Skeleton className="skeleton-meta ml-auto w-22.5 h-2.5 max-[740px]:shrink-0" />
        </div>
      ))}
    </div>
  );
}

export const usePreload = (...atoms: ReadonlyArray<Atom.Atom<unknown>>) => {
  const registry = useContext(RegistryContext);
  if (typeof window === "undefined") for (const atom of atoms) registry.mount(atom);
};
