import { useRef } from "react";
import {
  QueryClient,
  QueryClientProvider,
  mutationOptions,
  queryOptions,
  skipToken,
  useMutation as useTanStackMutation,
  useQuery as useTanStackQuery,
  useQueryClient as useTanStackQueryClient,
  type QueryClient as QueryClientType,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

export { QueryClient, QueryClientProvider, mutationOptions, queryOptions, skipToken };

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
