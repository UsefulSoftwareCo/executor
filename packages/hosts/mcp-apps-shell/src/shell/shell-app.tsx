// `virtual:executor-inner-renderer` is supplied by `innerRendererPlugin`
// (`@executor-js/mcp-apps-shell/vite`). Referenced explicitly — and first, as
// triple-slash directives are only honored above the imports — so the ambient
// declaration travels with this file into consumers that bundle the shell;
// a consumer's tsconfig `include` covers only its own sources.
/// <reference path="./inner-renderer-source.d.ts" />
import "./globals.css";
import "@tailwindcss/browser";

import React, { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useElicitationApproval } from "@executor-js/react/components/elicitation-approval";

import {
  createToolCaller,
  type ToolCallHost,
  type TrustedInteraction,
  type TrustedInteractionResponse,
} from "./proxy";
import * as Components from "./components";
import innerRendererScript from "virtual:executor-inner-renderer";
// Raw source, not a compiled stylesheet: the inner frame compiles utilities on
// demand against these tokens. See `buildRendererSrcDoc`.
import themeSource from "./theme.css?raw";
// The in-frame Tailwind compiler, as text to inline under a CSP that forbids
// fetching anything. Supplied by `tailwindBrowserSourcePlugin` — the package
// exports only its module entry, and this needs the bytes.
import tailwindBrowserScript from "virtual:executor-tailwind-browser";

type PendingInteraction = TrustedInteraction & {
  resolve: (response: TrustedInteractionResponse) => void;
};

export type McpAppsShellHost = ToolCallHost & {
  readonly getHostContext: () => McpUiHostContext | undefined;
  readonly openLink: (params: { url: string }) => Promise<unknown>;
  ontoolinput?: (params: { arguments?: Record<string, unknown> }) => void;
  ontoolresult?: (result: CallToolResult) => void;
  onerror?: (err: Error) => void;
  onhostcontextchanged?: (ctx: McpUiHostContext) => void;
};

type RendererState = {
  token: string;
  code: string;
  srcDoc: string;
  config: Record<string, unknown>;
  height: number;
};

type RendererRequest =
  | {
      type: "executor.toolCall";
      requestId: number;
      token: string;
      path: unknown;
      args: unknown;
    }
  | { type: "executor.renderer.ready"; token: string }
  | { type: "executor.renderer.config"; token: string; config: unknown }
  | { type: "executor.renderer.size"; token: string; height: unknown }
  | { type: "executor.renderer.error"; token: string; message: unknown };

// ---------------------------------------------------------------------------
// Theme application from MCP Apps host context
// ---------------------------------------------------------------------------

function applyTheme(ctx: McpUiHostContext) {
  if (ctx.theme) {
    document.documentElement.classList.toggle("dark", ctx.theme === "dark");
  }
}

/**
 * How tall the shell may grow before it scrolls internally, or `undefined` for
 * "as tall as the content is".
 *
 * Precedence, tightest first:
 *
 *  1. The generated component's own `config.maxHeight` — the author asked for a
 *     scroll box, so give them one.
 *  2. The host's `containerDimensions`, the MCP-Apps way of saying "this is the
 *     room you have".
 *  3. Otherwise NO cap. An app cannot know how much room its host has; the
 *     protocol's answer is for the app to report its true content height via
 *     `size-changed` and let the host size the frame. Capping here would also be
 *     circular for a host that does exactly that — the shell's own viewport IS
 *     the frame the host is trying to size, so measuring it would pin the frame
 *     to whatever height it already had.
 *
 * The old unconditional 800px default was case 3 done wrong: it silently clipped
 * anything taller, in every host, including ones with room to spare.
 */
const resolveMaxHeight = (
  config: Record<string, unknown>,
  hostContext: McpUiHostContext | undefined,
): number | undefined => {
  if (typeof config.maxHeight === "number") return config.maxHeight;

  const container = hostContext?.containerDimensions;
  if (container) {
    if ("height" in container && typeof container.height === "number") return container.height;
    if ("maxHeight" in container && typeof container.maxHeight === "number") {
      return container.maxHeight;
    }
  }

  return undefined;
};

const createRendererToken = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `renderer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

const escapeInlineHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeStyleContent = (value: string): string => value.replace(/<\/style/gi, "<\\/style");

const escapeScriptContent = (value: string): string => value.replace(/<\/script/gi, "<\\/script");

const collectShellCss = (): string =>
  Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join("\n");
      } catch {
        return "";
      }
    })
    .filter((css) => css.length > 0)
    .join("\n");

/**
 * The srcDoc the model's component renders into.
 *
 * It carries TWO stylesheets, and the difference between them is the whole
 * reason artifacts used to look half-styled:
 *
 *  - `collectShellCss()` is the shell's own COMPILED stylesheet, scraped out of
 *    the live document. It has the `@font-face` rules with their `data:` URLs
 *    already resolved (the build did that), plus every utility executor's own
 *    components happen to use. It cannot contain anything else, because
 *    Tailwind only emits utilities it saw in a source file at build time — and
 *    the model's code did not exist then.
 *
 *  - `themeSource` + the in-frame compiler is what makes the model's OWN
 *    classes real. `text-2xl`, `md:grid-cols-4`, `tracking-[0.08em]` — none of
 *    those appear in executor's components, so none of them were in the
 *    compiled sheet, and they silently did nothing: `text-2xl` computed to
 *    16px, a responsive grid stayed one column. The frame therefore gets the
 *    theme as SOURCE, in the `text/tailwindcss` style tag `@tailwindcss/browser`
 *    looks for, and compiles utilities on demand against executor's tokens.
 *
 * The compiler is inlined rather than fetched because the CSP here is
 * `default-src 'none'` with no `connect-src` — deliberately, since artifact code
 * is untrusted. Nothing in this frame may open a connection, so everything it
 * needs travels with it.
 */
const buildRendererSrcDoc = (token: string): string => {
  const css = collectShellCss();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="executor-render-token" content="${escapeInlineHtml(token)}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'">
    <style>${escapeStyleContent(css)}</style>
    <style type="text/tailwindcss">@import "tailwindcss";${escapeStyleContent(themeSource)}</style>
    <script>${escapeScriptContent(tailwindBrowserScript)}</script>
  </head>
  <body>
    <div id="root"></div>
    <script>${escapeScriptContent(innerRendererScript)}</script>
  </body>
</html>`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Shell App — connects to MCP host, receives code, renders components
// ---------------------------------------------------------------------------

export function McpAppsShell({
  app,
  initialCode,
}: {
  app: McpAppsShellHost;
  initialCode?: string | undefined;
}) {
  const [component, setComponent] = useState<React.ComponentType | null>(null);
  const [renderer, setRenderer] = useState<RendererState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const callToolRef = useRef<
    (path: readonly string[], args: readonly unknown[]) => Promise<unknown>
  >(() => Promise.resolve(null));
  const pendingInteractionRef = useRef<PendingInteraction | null>(null);
  const rendererFrameRef = useRef<HTMLIFrameElement | null>(null);
  const rendererRef = useRef<RendererState | null>(null);

  useEffect(() => {
    rendererRef.current = renderer;
  }, [renderer]);

  const requestTrustedInteraction = useCallback(
    (interaction: TrustedInteraction): Promise<TrustedInteractionResponse> =>
      new Promise((resolve) => {
        if (pendingInteractionRef.current) {
          resolve({ action: "cancel" });
          return;
        }

        const pending = { ...interaction, resolve };
        pendingInteractionRef.current = pending;
        setPendingInteraction(pending);
      }),
    [],
  );

  const completeTrustedInteraction = useCallback((response: TrustedInteractionResponse) => {
    const pending = pendingInteractionRef.current;
    pendingInteractionRef.current = null;
    setPendingInteraction(null);
    pending?.resolve(response);
  }, []);

  const postToRenderer = useCallback((message: Record<string, unknown>) => {
    const current = rendererRef.current;
    const target = rendererFrameRef.current?.contentWindow;
    if (!current || !target) return;
    target.postMessage({ ...message, token: current.token }, "*");
  }, []);

  useEffect(() => {
    const handleRendererMessage = (event: MessageEvent<RendererRequest>) => {
      const current = rendererRef.current;
      if (!current || event.source !== rendererFrameRef.current?.contentWindow) return;
      const data = event.data;
      if (!isRecord(data) || data.token !== current.token) return;
      const source = event.source;
      if (!source || typeof source.postMessage !== "function") return;
      const respond = (requestId: number, ok: boolean, value?: unknown, error?: string) => {
        source.postMessage(
          {
            type: "executor.response",
            requestId,
            token: current.token,
            ok,
            value,
            error,
          },
          "*",
        );
      };

      if (data.type === "executor.renderer.ready") {
        postToRenderer({
          type: "executor.render",
          code: current.code,
          theme: hostContext?.theme,
        });
        return;
      }

      if (data.type === "executor.renderer.config") {
        setRenderer((prev) =>
          prev && prev.token === current.token
            ? { ...prev, config: isRecord(data.config) ? data.config : {} }
            : prev,
        );
        return;
      }

      if (data.type === "executor.renderer.size") {
        const height = typeof data.height === "number" ? Math.ceil(data.height) : current.height;
        setRenderer((prev) =>
          prev && prev.token === current.token
            ? { ...prev, height: Math.max(120, Math.min(4000, height)) }
            : prev,
        );
        return;
      }

      if (data.type === "executor.renderer.error") {
        if (typeof data.message === "string") {
          console.error("[executor-shell] Renderer error:", data.message);
        }
        return;
      }

      // The ONLY request the generated iframe may make. There is no code
      // channel: the inner renderer sends a tool path plus args, and the outer
      // frame is what turns that into the one `execute-action` grammar.
      if (data.type === "executor.toolCall") {
        if (!Array.isArray(data.path)) {
          respond(data.requestId, false, undefined, "Invalid tool path.");
          return;
        }
        callToolRef
          .current(data.path as readonly string[], Array.isArray(data.args) ? data.args : [])
          .then((value) => respond(data.requestId, true, value))
          .catch((err: unknown) =>
            respond(
              data.requestId,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            ),
          );
      }
    };

    window.addEventListener("message", handleRendererMessage);
    return () => window.removeEventListener("message", handleRendererMessage);
  }, [hostContext?.theme, postToRenderer]);

  useEffect(() => {
    if (renderer) {
      postToRenderer({ type: "executor.theme", theme: hostContext?.theme });
    }
  }, [hostContext?.theme, postToRenderer, renderer]);

  /** Render a JSX code string in the sandboxed inner iframe. */
  const renderCode = useCallback((code: string) => {
    try {
      const token = createRendererToken();
      const nextRenderer = {
        token,
        code,
        srcDoc: buildRendererSrcDoc(token),
        config: {},
        height: 240,
      };
      rendererRef.current = nextRenderer;
      setRenderer(nextRenderer);
      setComponent(null);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Compilation error: ${msg}`);
      setComponent(null);
      rendererRef.current = null;
      setRenderer(null);
    }
  }, []);

  useEffect(() => {
    callToolRef.current = createToolCaller(app, requestTrustedInteraction);

    // Handle tool input — fires on init (including page reload) with
    // the tool arguments. For generative UI the arguments contain { code }.
    app.ontoolinput = (params: { arguments?: Record<string, unknown> }) => {
      const code = params.arguments?.code;
      if (code && typeof code === "string") {
        renderCode(code);
      }
    };

    app.ontoolresult = (result: CallToolResult) => {
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      const code = structured?.code;

      if (code && typeof code === "string") {
        renderCode(code);
        return;
      }

      // Not a generative UI result — render a data view
      const DataView = () => {
        const text = result.content?.find((c) => c.type === "text")?.text;
        const isError = (result as { isError?: boolean }).isError;
        const data = structured as Record<string, unknown> | undefined;

        return (
          <Components.Card>
            <Components.CardContent className="pt-4">
              {isError ? (
                <Components.Alert variant="destructive">
                  <Components.AlertCircle className="h-4 w-4" />
                  <Components.AlertTitle>Error</Components.AlertTitle>
                  <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                    {text ?? "Unknown error"}
                  </Components.AlertDescription>
                </Components.Alert>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[80vh]">
                  {data ? JSON.stringify(data, null, 2) : (text ?? "(no result)")}
                </pre>
              )}
            </Components.CardContent>
          </Components.Card>
        );
      };
      setComponent(() => DataView);
      rendererRef.current = null;
      setRenderer(null);
      setError(null);
    };

    app.onerror = (err) => {
      console.error("[executor-shell] App error:", err);
    };

    app.onhostcontextchanged = (ctx: McpUiHostContext) => {
      setHostContext((prev) => ({ ...prev, ...ctx }));
      applyTheme(ctx);
    };

    (app as { onteardown?: () => Promise<Record<string, never>> }).onteardown = async () => {
      return {};
    };
  }, [app, renderCode, requestTrustedInteraction]);

  // Apply initial host context
  useEffect(() => {
    const ctx = app.getHostContext();
    if (ctx) {
      setHostContext(ctx);
      applyTheme(ctx);
    }
  }, [app]);

  useEffect(() => {
    if (initialCode) renderCode(initialCode);
  }, [initialCode, renderCode]);

  if (error) {
    return (
      <div className="p-4">
        <Components.ArtifactError title="Couldn't render this artifact" error={error} />
      </div>
    );
  }

  if (!component && !renderer) {
    return (
      <div
        data-testid="shell-loading-state"
        className="flex min-h-[220px] items-center justify-center p-4"
      >
        <ShellLoadingState label="Preparing interactive UI" />
      </div>
    );
  }

  const Component = component;
  const config = renderer?.config ?? {};
  const maxHeight = resolveMaxHeight(config, hostContext);
  const rendererHeight = renderer
    ? maxHeight === undefined
      ? renderer.height
      : Math.min(renderer.height, maxHeight)
    : undefined;

  return (
    <Components.TooltipProvider>
      <div
        // No padding of its own when an artifact is rendering: the inner frame's
        // `.artifact-root` owns the artifact's outer padding, and padding on
        // both sides of the frame boundary reads as an unexplained double
        // margin. The non-artifact path (a raw tool result) still gets it.
        className={renderer ? "overflow-y-auto" : "p-4 overflow-y-auto"}
        style={{
          maxHeight,
          paddingTop: hostContext?.safeAreaInsets?.top,
          paddingRight: hostContext?.safeAreaInsets?.right,
          paddingBottom: hostContext?.safeAreaInsets?.bottom,
          paddingLeft: hostContext?.safeAreaInsets?.left,
        }}
      >
        {renderer ? (
          <iframe
            key={renderer.token}
            ref={rendererFrameRef}
            sandbox="allow-scripts"
            srcDoc={renderer.srcDoc}
            title="Generated UI"
            className="block w-full border-0 bg-background"
            style={{ height: rendererHeight }}
          />
        ) : Component ? (
          <ErrorBoundary>
            <Component />
          </ErrorBoundary>
        ) : null}
        {pendingInteraction && (
          <TrustedInteractionModal
            key={pendingInteraction.executionId}
            app={app}
            pending={pendingInteraction}
            onComplete={completeTrustedInteraction}
          />
        )}
      </div>
    </Components.TooltipProvider>
  );
}

function ShellLoadingState({ label }: { label: string }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-border bg-card/70 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Components.Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
            <span className="h-1.5 w-10 animate-pulse rounded-full bg-muted" />
            <span className="h-1.5 w-16 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Components.Skeleton className="h-2.5 w-11/12" />
        <Components.Skeleton className="h-2.5 w-7/12" />
        <Components.Skeleton className="h-16 w-full rounded-md" />
      </div>
    </div>
  );
}

function TrustedInteractionModal({
  app,
  pending,
  onComplete,
}: {
  app: McpAppsShellHost;
  pending: PendingInteraction;
  onComplete: (response: TrustedInteractionResponse) => void;
}) {
  const interaction = pending.interaction;
  const message =
    typeof interaction.message === "string" && interaction.message.length > 0
      ? interaction.message
      : "Approve this action?";
  const url = typeof interaction.url === "string" ? interaction.url : null;
  const approval = useElicitationApproval(interaction.requestedSchema);

  const approve = () => {
    const content = approval.content();
    if (content === null) return;
    onComplete({ action: "accept", content });
  };

  const openUrl = () => {
    if (!url) return;
    app.openLink({ url }).catch((err: unknown) => {
      console.error("[executor-shell] Failed to open elicitation URL:", err);
    });
  };

  return (
    <div
      data-testid="trusted-interaction-modal"
      className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-2 backdrop-blur-sm"
    >
      <div className="flex min-h-full items-start justify-center">
        <div
          data-testid="trusted-interaction-card"
          className="flex max-h-[calc(100vh-1rem)] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">Approve action</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              This approval is handled by the Executor shell.
            </div>
          </div>
          <div
            data-testid="trusted-interaction-body"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
          >
            <div className="text-sm">{message}</div>
            {url && (
              <Components.Button
                type="button"
                onClick={openUrl}
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-2.5 text-xs"
              >
                <Components.ExternalLink className="h-3.5 w-3.5" />
                Open link
              </Components.Button>
            )}
            {approval.hasFields && approval.fields}
          </div>
          <div
            data-testid="trusted-interaction-footer"
            className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3"
          >
            <Components.Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onComplete({ action: "cancel" })}
            >
              Cancel
            </Components.Button>
            <Components.Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onComplete({ action: "decline" })}
            >
              Decline
            </Components.Button>
            <Components.Button type="button" size="sm" onClick={approve}>
              Approve
            </Components.Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error boundary for catching runtime errors in model-generated components
// ---------------------------------------------------------------------------

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
        <Components.ArtifactError
          title="This view stopped rendering"
          error={this.state.error}
          hint="Reopen the artifact, or ask the agent to rebuild it."
        />
      );
    }
    return this.props.children;
  }
}
