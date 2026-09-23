import { createContext, useContext, type ReactNode } from "react";
import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { Option } from "effect";
import { Skeleton } from "../components/skeleton.tsx";
import { AsyncResult } from "effect/unstable/reactivity";
import type { DashboardBindings, Query, QueryProps } from "../../contracts/dashboard.ts";

const Context = createContext<DashboardBindings | null>(null);
/** Bind product navigation and icon metadata, without an HTTP client or an auth context. */
export function DashboardProvider({
  children,
  ...bindings
}: DashboardBindings & { readonly children: ReactNode }) {
  return <Context value={bindings}>{children}</Context>;
}
/** Shared pages use product navigation without importing its router. */
export function useDashboard() {
  const value = useContext(Context);
  if (value === null) throw new Error("DashboardProvider must enclose this page");
  return value;
}
/** Icons can also render outside an authenticated dashboard, using an explicit provider URL. */
export const useOptionalDashboard = () => useContext(Context);
/** Read the current value or a previous success, when the source provides one. */
export function useQuery<A, E>(atom: Query<A, E>) {
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return { result, data: AsyncResult.value(result), refresh };
}

/** Loading/failure rendering follows the same source lifetime in every host. */
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

/** Render a query snapshot without subscribing again. Error and content retain separate React positions. */
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
  // Keep the content in the same slot when an error appears or clears. Returning
  // a different fragment from each matcher branch can remount unkeyed children.
  return (
    <>
      {view.error}
      {view.content}
    </>
  );
}

/** Stable loading rows retain the eventual list footprint. */
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
