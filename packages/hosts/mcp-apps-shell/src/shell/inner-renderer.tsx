import React, { type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { compileJsx, evaluateComponent } from "./component-runtime";
import * as Components from "./components";
import { createToolsProxy, type ToolCallRequest } from "./tools-proxy";

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

/** The shell's transport for the shared `tools` proxy: every call becomes a
 *  `postMessage` to the parent frame, settled when the shell answers. */
const requestParentToolCall = (request: ToolCallRequest): Promise<unknown> =>
  requestParent({
    type: "executor.toolCall",
    path: [...request.path],
    args: [...request.args],
    ...(request.role === undefined ? {} : { role: request.role }),
  });

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
    const evalResult = evaluateComponent(compiled, createToolsProxy(requestParentToolCall));

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
