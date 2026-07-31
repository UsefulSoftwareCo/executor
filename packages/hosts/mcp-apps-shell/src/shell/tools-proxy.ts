/**
 * The `tools` proxy — the only object generated artifact code reaches an
 * integration through.
 *
 * It lives here, apart from the inner renderer, because it now has two callers
 * with the same shape and different transports:
 *
 *  - the inner renderer, whose `request` posts the call to the parent frame and
 *    settles when the shell answers;
 *  - the create-time smoke render, whose `request` never settles at all, so
 *    every query stays pending and the component renders its loading state.
 *
 * Sharing the proxy rather than writing a stub for the second caller is the
 * point. Generated code touches far more of this surface than `queryOptions` —
 * `.queryFilter()`, `.pathFilter()`, `.mutationOptions()` and the infinite
 * variants all run DURING render — so a hand-rolled stand-in would drift from
 * the real thing and the smoke render would start rejecting code that works, or
 * passing code that doesn't. One implementation, two transports.
 */

import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  skipToken,
  type MutationKey,
  type QueryFilters,
  type QueryKey,
  type UseInfiniteQueryOptions,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

/** One tool call, as the proxy emits it. The transport decides what to do with
 *  it; nothing here knows about frames or messages. */
export type ToolCallRequest = {
  readonly path: readonly string[];
  readonly args: readonly unknown[];
  readonly role?: string;
};

/** How a tool call is carried out. Returning a promise that never settles is a
 *  legitimate implementation — it is what the smoke render uses to hold every
 *  query in its pending state. */
export type ToolCallTransport = (request: ToolCallRequest) => Promise<unknown>;

/**
 * The role is part of every cache key, not just the wire call.
 *
 * `tools.linear("prod").issues.list` and `tools.linear("staging").issues.list`
 * share a path but not an account, so a key built from the path alone would
 * serve one role's rows to the other and make a mutation on one invalidate the
 * other. Undefined for the untagged single-account form, which keeps every key
 * an artifact wrote before roles existed byte-identical.
 */
const toolScope = (path: readonly string[], role: string | undefined): QueryKey =>
  role === undefined ? ["executor-tool", path] : ["executor-tool", path, { role }];

const toolQueryKey = (
  path: readonly string[],
  role: string | undefined,
  input?: unknown,
): QueryKey => [...toolScope(path, role), { input, type: "query" }];

const toolInfiniteQueryKey = (
  path: readonly string[],
  role: string | undefined,
  input?: unknown,
): QueryKey => [...toolScope(path, role), { input, type: "infinite" }];

const toolPathKey = (path: readonly string[], role: string | undefined): QueryKey =>
  toolScope(path, role);

const toolMutationKey = (path: readonly string[], role: string | undefined): MutationKey => [
  ...toolScope(path, role),
  { type: "mutation" },
];

const queryFilter = (
  path: readonly string[],
  role: string | undefined,
  input?: unknown,
  filters?: Omit<QueryFilters, "queryKey">,
): QueryFilters => ({
  ...filters,
  queryKey: toolQueryKey(path, role, input),
});

const pathFilter = (
  path: readonly string[],
  role: string | undefined,
  filters?: Omit<QueryFilters, "queryKey">,
): QueryFilters => ({
  ...filters,
  queryKey: toolPathKey(path, role),
});

/**
 * Where a page cursor lands inside a tool's input.
 *
 * A dotted path rather than a merge function, deliberately: it is data, so the
 * paging contract of an artifact can be read statically out of its source the
 * same way `tools.<integration>.<...>` paths are. Nested inputs — the common
 * OpenAPI `{ query: { … } }` shape — are reachable as `"query.cursor"`.
 */
const DEFAULT_CURSOR_KEY = "cursor";

/** `input` with `pageParam` written at `cursorKey`, cloning only the spine it
 *  touches so the caller's object is never mutated. A nullish page param writes
 *  nothing at all, which is what makes `initialPageParam: null` mean "the first
 *  request carries no cursor". */
const withCursor = (input: unknown, cursorKey: string, pageParam: unknown): unknown => {
  const base = input === undefined ? {} : input;
  if (pageParam === null || pageParam === undefined) return base;

  // Recurse over the remaining segments rather than an index, so "the head
  // exists" is a fact about the array rather than something to assert.
  const assign = (target: unknown, [segment, ...rest]: readonly string[]): unknown => {
    if (segment === undefined) return pageParam;
    const record: Record<string, unknown> =
      typeof target === "object" && target !== null && !Array.isArray(target)
        ? { ...(target as Record<string, unknown>) }
        : {};
    record[segment] = rest.length === 0 ? pageParam : assign(record[segment], rest);
    return record;
  };

  return assign(base, cursorKey.split("."));
};

/** The model-facing half of `.infiniteQueryOptions`: TanStack's own infinite
 *  options (minus the two the proxy owns) plus the cursor placement. */
type ToolInfiniteQueryOptions = Omit<
  UseInfiniteQueryOptions,
  "queryKey" | "queryFn" | "initialPageParam"
> & {
  readonly initialPageParam?: unknown;
  readonly cursorKey?: string;
};

/**
 * Build the `tools` proxy over a transport.
 *
 * A path under `tools` is an INTEGRATION followed by a tool path —
 * `tools.vercel.domains.getDomains` — with no tier and no connection name. The
 * account is chosen by the artifact's stored bindings, server-side.
 *
 * At integration depth the proxy is also callable with a string: that is the
 * ROLE form, `tools.linear("prod").issues.list`, for an artifact that uses two
 * accounts of one integration. The role rides with every request and every
 * cache key from that point down. Calling with anything else at that depth is
 * an ordinary tool invocation of a one-segment path, which is how the system
 * tools (`tools.search({...})`) are reached — so the two are told apart by the
 * argument, not by position: exactly one string argument tags a role.
 */
export const createToolsProxy = (request: ToolCallTransport): Record<string, unknown> => {
  const nest = (path: string[], role: string | undefined): unknown =>
    new Proxy(function () {}, {
      get(_target, key: string | symbol) {
        if (key === "then" || key === "toJSON" || key === Symbol.toPrimitive) return undefined;
        if (typeof key !== "string") return undefined;
        if (key === "queryOptions") {
          return (input?: unknown, options?: Omit<UseQueryOptions, "queryKey" | "queryFn">) =>
            queryOptions({
              ...options,
              queryKey: toolQueryKey(path, role, input === skipToken ? undefined : input),
              queryFn:
                input === skipToken
                  ? skipToken
                  : () =>
                      request({
                        path,
                        args: [input ?? {}],
                        ...(role === undefined ? {} : { role }),
                      }),
            });
        }
        if (key === "infiniteQueryOptions") {
          return (input?: unknown, options?: ToolInfiniteQueryOptions) => {
            const {
              cursorKey = DEFAULT_CURSOR_KEY,
              initialPageParam = null,
              ...rest
            } = options ?? {};
            return infiniteQueryOptions({
              ...rest,
              initialPageParam,
              queryKey: toolInfiniteQueryKey(path, role, input === skipToken ? undefined : input),
              queryFn:
                input === skipToken
                  ? skipToken
                  : ({ pageParam }: { pageParam: unknown }) =>
                      request({
                        path,
                        args: [withCursor(input, cursorKey, pageParam)],
                        ...(role === undefined ? {} : { role }),
                      }),
              // oxlint-disable-next-line executor/no-double-cast -- boundary: TanStack's option types are generic over the page-param type the model supplies at runtime
            } as unknown as UseInfiniteQueryOptions);
          };
        }
        if (key === "infiniteQueryKey") {
          return (input?: unknown) => toolInfiniteQueryKey(path, role, input);
        }
        if (key === "infiniteQueryFilter") {
          return (input?: unknown, filters?: Omit<QueryFilters, "queryKey">) => ({
            ...filters,
            queryKey: toolInfiniteQueryKey(path, role, input),
          });
        }
        if (key === "queryKey") {
          return (input?: unknown) => toolQueryKey(path, role, input);
        }
        if (key === "queryFilter") {
          return (input?: unknown, filters?: Omit<QueryFilters, "queryKey">) =>
            queryFilter(path, role, input, filters);
        }
        if (key === "pathKey") {
          return () => toolPathKey(path, role);
        }
        if (key === "pathFilter") {
          return (filters?: Omit<QueryFilters, "queryKey">) => pathFilter(path, role, filters);
        }
        if (key === "mutationOptions") {
          return (options?: Omit<UseMutationOptions, "mutationKey" | "mutationFn">) =>
            mutationOptions({
              ...options,
              mutationKey: toolMutationKey(path, role),
              mutationFn: (input?: unknown) =>
                request({
                  path,
                  args: [input ?? {}],
                  ...(role === undefined ? {} : { role }),
                }),
            });
        }
        if (key === "mutationKey") {
          return () => toolMutationKey(path, role);
        }
        return nest([...path, key], role);
      },
      apply(_target, _thisArg, args: unknown[]) {
        const [only] = args;
        if (
          path.length === 1 &&
          role === undefined &&
          args.length === 1 &&
          typeof only === "string"
        ) {
          return nest(path, only);
        }
        return request({
          path,
          args,
          ...(role === undefined ? {} : { role }),
        });
      },
    });

  return nest([], undefined) as Record<string, unknown>;
};
