import React, { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
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

import { compileJsx, evaluateComponent } from "./component-runtime";
import * as Components from "./components";

type ParentRequestPayload = {
  type: "executor.toolCall";
  path: string[];
  args: unknown[];
  role?: string;
};

type ParentResponse = {
  type: "executor.response";
  requestId: number;
  token: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

type RenderMessage = {
  type: "executor.render";
  token: string;
  code: string;
  theme?: unknown;
};

type ThemeMessage = {
  type: "executor.theme";
  token: string;
  theme?: unknown;
};

type InboundMessage = ParentResponse | RenderMessage | ThemeMessage;

const token = document.querySelector<HTMLMetaElement>(
  "meta[name='executor-render-token']",
)?.content;

if (!token) {
  throw new Error("Missing renderer token.");
}

const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }
>();

let nextRequestId = 0;
let root: ReturnType<typeof createRoot> | null = null;

const blockedNetwork = (name: string) => () => {
  throw new Error(`${name} is disabled in generated UI. Use tools.* via useQuery/useMutation.`);
};

Object.assign(globalThis, {
  fetch: blockedNetwork("fetch"),
  XMLHttpRequest: blockedNetwork("XMLHttpRequest"),
  WebSocket: blockedNetwork("WebSocket"),
  EventSource: blockedNetwork("EventSource"),
  Worker: blockedNetwork("Worker"),
  SharedWorker: blockedNetwork("SharedWorker"),
});

const sendParent = (message: Record<string, unknown>) => {
  window.parent.postMessage({ ...message, token }, "*");
};

const requestParent = (message: ParentRequestPayload): Promise<unknown> => {
  const requestId = ++nextRequestId;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    sendParent({ ...message, requestId });
  });
};

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

let queryClient: QueryClient = makeQueryClient();

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
 * The `tools` proxy.
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
const createToolsProxy = (): Record<string, unknown> => {
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
                      requestParent({
                        type: "executor.toolCall",
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
                      requestParent({
                        type: "executor.toolCall",
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
                requestParent({
                  type: "executor.toolCall",
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
        return requestParent({
          type: "executor.toolCall",
          path,
          args,
          ...(role === undefined ? {} : { role }),
        });
      },
    });

  return nest([], undefined) as Record<string, unknown>;
};

const applyTheme = (theme: unknown) => {
  if (theme === "dark" || theme === "light") {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
};

/**
 * Mount into the shell-owned container.
 *
 * `.artifact-root` carries the artifact's outer padding and max width, so every
 * artifact is framed identically whether or not its author thought about it —
 * and the skill can tell the model NOT to add a page-level `p-6`, because
 * doubling it is the visible failure. Applied here rather than in the srcDoc's
 * markup so the class travels with whatever renders, including the error paths.
 */
const renderNode = (node: ReactNode) => {
  const mount = document.getElementById("root");
  if (!mount) return;
  mount.classList.add("artifact-root");
  root ??= createRoot(mount);
  root.render(<Components.TooltipProvider>{node}</Components.TooltipProvider>);
};

const renderError = (title: string, message: string) => {
  renderNode(<Components.ArtifactError title={title} error={message} />);
  sendParent({ type: "executor.renderer.error", message });
};

class ErrorBoundary extends React.Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      // The stack is deliberately dropped. Whoever is looking at an artifact
      // did not write it, so a trace is noise to them and the real audience —
      // the model — gets the message back over `executor.renderer.error`.
      return (
        <Components.ArtifactError
          title="This artifact stopped rendering"
          error={this.state.error}
          hint="The component threw while rendering. Ask the agent to fix it, or reopen the artifact."
        />
      );
    }
    return this.props.children;
  }
}

const renderGeneratedCode = (code: string) => {
  try {
    const compiled = compileJsx(code);
    const evalResult = evaluateComponent(compiled, createToolsProxy());

    if ("error" in evalResult) {
      renderError("Error", evalResult.error);
      return;
    }

    sendParent({ type: "executor.renderer.config", config: evalResult.config });
    const Component = evalResult.component;
    queryClient = makeQueryClient();
    renderNode(
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <Component />
        </ErrorBoundary>
      </QueryClientProvider>,
    );
  } catch (err) {
    renderError("Compilation Error", err instanceof Error ? err.message : String(err));
  }
};

window.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.token !== token) return;

  if (data.type === "executor.response") {
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    if (data.ok) {
      entry.resolve(data.value);
    } else {
      entry.reject(new Error(data.error ?? "Renderer request failed"));
    }
    return;
  }

  if (data.type === "executor.theme") {
    applyTheme(data.theme);
    return;
  }

  if (data.type === "executor.render") {
    applyTheme(data.theme);
    renderGeneratedCode(data.code);
  }
});

const resizeObserver = new ResizeObserver(([entry]) => {
  sendParent({
    type: "executor.renderer.size",
    height: Math.ceil(entry.contentRect.height),
  });
});

resizeObserver.observe(document.body);
sendParent({ type: "executor.renderer.ready" });
