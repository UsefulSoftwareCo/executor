import React, { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  mutationOptions,
  queryOptions,
  skipToken,
  type MutationKey,
  type QueryFilters,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { compileJsx, evaluateComponent } from "./component-runtime";
import * as Components from "./components";

type ParentRequestPayload =
  | { type: "executor.toolCall"; path: string[]; args: unknown[] }
  | { type: "executor.run"; code: string };

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

const toolQueryKey = (path: readonly string[], input?: unknown): QueryKey => [
  "executor-tool",
  path,
  { input, type: "query" },
];

const toolPathKey = (path: readonly string[]): QueryKey => ["executor-tool", path];

const toolMutationKey = (path: readonly string[]): MutationKey => [
  "executor-tool",
  path,
  { type: "mutation" },
];

const queryFilter = (
  path: readonly string[],
  input?: unknown,
  filters?: Omit<QueryFilters, "queryKey">,
): QueryFilters => ({
  ...filters,
  queryKey: toolQueryKey(path, input),
});

const pathFilter = (
  path: readonly string[],
  filters?: Omit<QueryFilters, "queryKey">,
): QueryFilters => ({
  ...filters,
  queryKey: toolPathKey(path),
});

const createToolsProxy = (): Record<string, unknown> => {
  const nest = (path: string[]): unknown =>
    new Proxy(function () {}, {
      get(_target, key: string | symbol) {
        if (key === "then" || key === "toJSON" || key === Symbol.toPrimitive) return undefined;
        if (typeof key !== "string") return undefined;
        if (key === "queryOptions") {
          return (input?: unknown, options?: Omit<UseQueryOptions, "queryKey" | "queryFn">) =>
            queryOptions({
              ...options,
              queryKey: toolQueryKey(path, input === skipToken ? undefined : input),
              queryFn:
                input === skipToken
                  ? skipToken
                  : () => requestParent({ type: "executor.toolCall", path, args: [input ?? {}] }),
            });
        }
        if (key === "queryKey") {
          return (input?: unknown) => toolQueryKey(path, input);
        }
        if (key === "queryFilter") {
          return (input?: unknown, filters?: Omit<QueryFilters, "queryKey">) =>
            queryFilter(path, input, filters);
        }
        if (key === "pathKey") {
          return () => toolPathKey(path);
        }
        if (key === "pathFilter") {
          return (filters?: Omit<QueryFilters, "queryKey">) => pathFilter(path, filters);
        }
        if (key === "mutationOptions") {
          return (options?: Omit<UseMutationOptions, "mutationKey" | "mutationFn">) =>
            mutationOptions({
              ...options,
              mutationKey: toolMutationKey(path),
              mutationFn: (input?: unknown) =>
                requestParent({ type: "executor.toolCall", path, args: [input ?? {}] }),
            });
        }
        if (key === "mutationKey") {
          return () => toolMutationKey(path);
        }
        return nest([...path, key]);
      },
      apply(_target, _thisArg, args: unknown[]) {
        return requestParent({ type: "executor.toolCall", path, args });
      },
    });

  return nest([]) as Record<string, unknown>;
};

const run = (code: string): Promise<unknown> => requestParent({ type: "executor.run", code });

const applyTheme = (theme: unknown) => {
  if (theme === "dark" || theme === "light") {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
};

const renderNode = (node: ReactNode) => {
  const mount = document.getElementById("root");
  if (!mount) return;
  root ??= createRoot(mount);
  root.render(<Components.TooltipProvider>{node}</Components.TooltipProvider>);
};

const renderError = (title: string, message: string) => {
  renderNode(
    <div className="flex min-h-screen items-center justify-center p-4">
      <Components.Alert variant="destructive">
        <Components.AlertCircle className="h-4 w-4" />
        <Components.AlertTitle>{title}</Components.AlertTitle>
        <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
          {message}
        </Components.AlertDescription>
      </Components.Alert>
    </div>,
  );
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
      return (
        <Components.Alert variant="destructive">
          <Components.AlertCircle className="h-4 w-4" />
          <Components.AlertTitle>Runtime Error</Components.AlertTitle>
          <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {this.state.error.message}
            {this.state.error.stack && (
              <pre className="mt-2 text-xs opacity-60">{this.state.error.stack}</pre>
            )}
          </Components.AlertDescription>
        </Components.Alert>
      );
    }
    return this.props.children;
  }
}

const renderGeneratedCode = (code: string) => {
  try {
    const compiled = compileJsx(code);
    const evalResult = evaluateComponent(compiled, createToolsProxy(), run);

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
