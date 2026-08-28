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
  /**
   * Whether the embedding host can store a preview snapshot.
   *
   * Only the console can: it has an endpoint to PUT one to. Inside a real MCP
   * client (Claude and friends) the capture message would travel to a host that
   * has nowhere to put it, so the work is simply not done there. The flag comes
   * from the host rather than being inferred, because "who is embedding me" is
   * not something this frame can know.
   */
  capturePreview?: unknown;
  /**
   * Whether the shell has a bounded viewport for this artifact to fill.
   *
   * Told to the frame rather than inferred: this document cannot see the MCP
   * host context, and its own height is whatever the shell gave it, so there is
   * nothing here to measure. See `./display-mode`.
   */
  fill?: unknown;
};

type ThemeMessage = {
  type: "executor.theme";
  token: string;
  theme?: unknown;
};

/** A mode change arriving after this frame has already rendered. */
type FillMessage = {
  type: "executor.fill";
  token: string;
  fill?: unknown;
};

type InboundMessage = ParentResponse | RenderMessage | ThemeMessage | FillMessage;

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
 * Bind this document to its frame, so an artifact's own `h-full` means something.
 *
 * This is the LAST link in the height chain — page content area -> outer frame ->
 * shell document -> this srcdoc frame -> `#root` -> the artifact's root element.
 * The `html.artifact-fill` rule in `theme.css` gives `html`, `body` and `#root` a
 * definite `height: 100%`; without it every one of them is `auto` and a
 * percentage height inside the artifact has no parent height to resolve against.
 *
 * `.artifact-root` gets `display: flex` with it, so the artifact's own root
 * element is a flex child that can actually be told to fill — an `h-full` child
 * of a plain block box would still only be as tall as the box's content.
 */
const applyFill = (fill: unknown) => {
  document.documentElement.classList.toggle("artifact-fill", fill === true);
};

/**
 * Tell the shell, once, that this frame has actually painted something.
 *
 * A host holding a single loading surface across the whole open — the console
 * does — needs to know when to take it down, and every cheaper proxy is a
 * different fact:
 *
 *  - The `executor.render` message only says the code was DELIVERED. Compiling
 *    it (Babel, then the in-frame Tailwind JIT) is the slow part, and revealing
 *    the frame here shows a blank white box for as long as that takes.
 *  - The first `executor.renderer.size` is not it either. The `ResizeObserver`
 *    below fires its initial callback on `observe()`, against an empty body,
 *    BEFORE any render message can arrive — so the earliest size report is a
 *    height of zero for a document with nothing in it.
 *
 * So the signal is emitted from inside the React tree, where "committed" is not
 * a guess: the effect runs after React has committed the tree, and the
 * animation frame after it puts the message one paint later still. That is the
 * first instant at which a host swapping to this frame swaps to real pixels.
 *
 * It fires for the ERROR surfaces too, because `renderError` renders through
 * the same path. That is deliberate — the question a host is asking is "should
 * the user be looking at the frame instead of my skeleton", and a failed
 * artifact answers yes. A signal that only fired on success would hide every
 * failure under a loading state forever.
 */
function RenderSignal(props: { readonly children: ReactNode }) {
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      sendParent({ type: "executor.renderer.rendered" });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <>{props.children}</>;
}

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
  // The signal wraps the tree rather than following `root.render(...)` as a
  // callback: `render` is not synchronous under a concurrent root, so a message
  // posted after the call can beat the commit it is meant to announce. A
  // `key` per mount is not needed — the effect belongs to this root's lifetime,
  // and a re-render into the same root is the same artifact still on screen.
  root.render(
    <RenderSignal>
      <Components.TooltipProvider>{node}</Components.TooltipProvider>
    </RenderSignal>,
  );
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

// ---------------------------------------------------------------------------
// Preview capture — the artifact as it actually looks, once it has data.
// ---------------------------------------------------------------------------

/** How long the render must be quiet before it counts as settled. */
const SETTLE_QUIET_MS = 2000;

/** A ceiling on waiting for quiet, for an artifact that polls forever. */
const SETTLE_DEADLINE_MS = 15_000;

/** Cap on the captured markup, mirroring the endpoint's own limit. */
const CAPTURE_LIMIT = 512 * 1024;

/** At most one capture per render: the first settled picture is the artifact. */
let capturedThisRender = false;

/**
 * Serialize the settled render as sanitizable HTML.
 *
 * ## Why this is not a raster
 *
 * The intent was pixels: SVG `foreignObject` -> `<img>` -> canvas -> PNG. That
 * cannot work here, and the reason is structural rather than incidental.
 *
 * The inner frame is a `srcdoc` iframe sandboxed WITHOUT `allow-same-origin`,
 * so it runs in an opaque origin. Every image is therefore cross-origin to it,
 * including one built from its own bytes — a 203-byte inline SVG through a blob
 * URL taints the canvas exactly as a remote JPEG would, and `toDataURL` then
 * throws `SecurityError: Tainted canvases may not be exported`. Measured, not
 * assumed: the trivial case fails identically to the real one. Nothing short of
 * granting the frame a real origin fixes it, and that origin is the entire
 * sandbox — the frame runs model-written code, so it is not negotiable.
 *
 * So the upgrade captures the settled DOM instead. That keeps what actually
 * makes the second layer worth having: the layout preview is the artifact
 * before its data arrives, and this is the artifact WITH its data — real
 * numbers, real rows, real labels — which is the difference a viewer sees on
 * the card. It gives up only the exact typeface and pixel-level fidelity.
 *
 * The markup goes through the same sanitizer as the create-time preview, so
 * nothing about how the console renders it changes.
 */
const captureSettledHtml = (target: HTMLElement): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort capture, every failure degrades to "no upgrade"
  try {
    const html = target.innerHTML;
    // Bounded here as well as at the endpoint: a settled render can be far
    // larger than its loading state (every row is present now), and the whole
    // point of the cap is that the gallery stays cheap to list.
    return html.length === 0 || html.length > CAPTURE_LIMIT ? null : html;
  } catch {
    return null;
  }
};

/**
 * Wait for the render to go quiet, then capture it once.
 *
 * "Quiet" is defined against the QueryClient rather than a timer alone: as long
 * as any query is fetching, the artifact is still filling in, and a snapshot
 * then would be of a half-loaded UI. Once nothing is in flight for
 * `SETTLE_QUIET_MS`, what is on screen is what the artifact looks like.
 *
 * The deadline is the backstop for an artifact that polls on an interval and
 * therefore never goes quiet: capture the best available picture rather than
 * none at all.
 */
const captureWhenSettled = () => {
  if (capturedThisRender) return;
  const mount = document.getElementById("root");
  if (!mount) return;

  const started = Date.now();
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    if (quietTimer !== undefined) clearTimeout(quietTimer);
    if (capturedThisRender) return;
    capturedThisRender = true;
    const preview = captureSettledHtml(mount);
    if (preview !== null) sendParent({ type: "executor.renderer.preview", preview });
  };

  const arm = () => {
    if (quietTimer !== undefined) clearTimeout(quietTimer);
    if (Date.now() - started > SETTLE_DEADLINE_MS) {
      finish();
      return;
    }
    quietTimer = setTimeout(() => {
      if (queryClient.isFetching() > 0) {
        arm();
        return;
      }
      finish();
    }, SETTLE_QUIET_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (!done) arm();
  });
  arm();
};

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

  if (data.type === "executor.fill") {
    applyFill(data.fill);
    return;
  }

  if (data.type === "executor.render") {
    applyTheme(data.theme);
    applyFill(data.fill);
    // A fresh render is a fresh picture: the previous capture, if any, was of
    // different code.
    capturedThisRender = false;
    renderGeneratedCode(data.code);
    // Only where the host said it can store one. Everywhere else — every real
    // MCP client — the work is skipped entirely rather than done and dropped.
    if (data.capturePreview === true) captureWhenSettled();
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
