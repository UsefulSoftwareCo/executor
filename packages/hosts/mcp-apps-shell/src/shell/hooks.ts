import { useRef } from "react";
import {
  QueryClient,
  QueryClientProvider,
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  skipToken,
  useInfiniteQuery as useTanStackInfiniteQuery,
  useMutation as useTanStackMutation,
  useQuery as useTanStackQuery,
  useQueryClient as useTanStackQueryClient,
  type InfiniteData,
  type QueryClient as QueryClientType,
  type QueryKey,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

export {
  QueryClient,
  QueryClientProvider,
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  skipToken,
};

const invalidationScopes: Array<Array<Promise<unknown>>> = [];

const trackInvalidation = (promise: Promise<unknown>) => {
  for (const scope of invalidationScopes) {
    scope.push(promise);
  }
  return promise;
};

const trackMutationCallback = async <T>(callback: () => T | Promise<T>): Promise<T> => {
  const scope: Array<Promise<unknown>> = [];
  invalidationScopes.push(scope);
  try {
    const result = await callback();
    await Promise.allSettled(scope);
    return result;
  } finally {
    invalidationScopes.pop();
  }
};

const wrapQueryClient = (client: QueryClientType): QueryClientType =>
  new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "invalidateQueries" && typeof value === "function") {
        return (...args: unknown[]) =>
          trackInvalidation(
            (value as (...args: unknown[]) => Promise<unknown>).apply(target, args),
          );
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as QueryClientType;

export const useQueryClient = (queryClient?: QueryClientType): QueryClientType => {
  const client = useTanStackQueryClient(queryClient);
  const wrappedRef = useRef<{ client: QueryClientType; wrapped: QueryClientType } | null>(null);

  if (wrappedRef.current?.client !== client) {
    wrappedRef.current = { client, wrapped: wrapQueryClient(client) };
  }

  return wrappedRef.current.wrapped;
};

const wrapMutationOptions = <TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationOptions<TData, TError, TVariables, TContext> => ({
  ...options,
  onSuccess: options.onSuccess
    ? (...args: Parameters<NonNullable<typeof options.onSuccess>>) =>
        trackMutationCallback(() => options.onSuccess?.(...args))
    : undefined,
  onError: options.onError
    ? (...args: Parameters<NonNullable<typeof options.onError>>) =>
        trackMutationCallback(() => options.onError?.(...args))
    : undefined,
  onSettled: options.onSettled
    ? (...args: Parameters<NonNullable<typeof options.onSettled>>) =>
        trackMutationCallback(() => options.onSettled?.(...args))
    : undefined,
});

export function useQuery<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends readonly unknown[] = readonly unknown[],
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClientType,
): UseQueryResult<TData, TError>;
export function useQuery<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends readonly unknown[] = readonly unknown[],
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClientType,
): UseQueryResult<TData, TError> {
  return useTanStackQuery(options, queryClient);
}

/**
 * `useInfiniteQuery` for cursor pagination, fed by
 * `tools.<path>.infiniteQueryOptions(...)`.
 *
 * Pass-through like `useQuery`: the invalidation tracking lives in
 * `useQueryClient` and the mutation callbacks, and infinite queries participate
 * in it through the same proxy-minted query keys, so no wrapping is needed here.
 */
export function useInfiniteQuery<
  TQueryFnData,
  TError = Error,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
  queryClient?: QueryClientType,
): UseInfiniteQueryResult<TData, TError>;
export function useInfiniteQuery<
  TQueryFnData,
  TError = Error,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
  queryClient?: QueryClientType,
): UseInfiniteQueryResult<TData, TError> {
  return useTanStackInfiniteQuery(options, queryClient);
}

export function useMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  queryClient?: QueryClientType,
): UseMutationResult<TData, TError, TVariables, TContext>;
export function useMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  queryClient?: QueryClientType,
): UseMutationResult<TData, TError, TVariables, TContext> {
  return useTanStackMutation(wrapMutationOptions(options), queryClient);
}
