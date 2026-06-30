import "./globals.css";
import "@tailwindcss/browser";

import React, { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useElicitationApproval } from "@executor-js/react/components/elicitation-approval";

import {
  createToolsProxy,
  createRunFn,
  type ToolCallHost,
  type TrustedInteraction,
  type TrustedInteractionResponse,
} from "./proxy";
import * as Components from "./components";
import innerRendererScript from "virtual:executor-inner-renderer";

type PendingInteraction = TrustedInteraction & {
  resolve: (response: TrustedInteractionResponse) => void;
};

export type DynamicUiShellHost = ToolCallHost & {
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
  | { type: "executor.run"; requestId: number; token: string; code: unknown }
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

const buildRendererSrcDoc = (token: string): string => {
  const css = collectShellCss();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="executor-render-token" content="${escapeInlineHtml(token)}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'">
    <style>${escapeStyleContent(css)}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${escapeScriptContent(innerRendererScript)}</script>
  </body>
</html>`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL_PATH_SEGMENT = /^[A-Za-z_$][\w$]*$/;

const toolPathToCode = (path: unknown, args: unknown): string => {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error("Invalid tool path.");
  }
  const parts = path.map((part) => {
    if (typeof part !== "string" || !TOOL_PATH_SEGMENT.test(part)) {
      throw new Error("Invalid tool path.");
    }
    return part;
  });
  const argList = Array.isArray(args) ? args : [];
  const serializedArgs = JSON.stringify(argList[0] ?? {});
  return `return await tools.${parts.join(".")}(${serializedArgs})`;
};

// ---------------------------------------------------------------------------
// Shell App — connects to MCP host, receives code, renders components
// ---------------------------------------------------------------------------

export function DynamicUiShell({
  app,
  initialCode,
}: {
  app: DynamicUiShellHost;
  initialCode?: string | undefined;
}) {
  const [component, setComponent] = useState<React.ComponentType | null>(null);
  const [renderer, setRenderer] = useState<RendererState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const toolsRef = useRef<Record<string, unknown>>({});
  const runRef = useRef<(code: string) => Promise<unknown>>(() => Promise.resolve(null));
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

      if (data.type === "executor.run") {
        if (typeof data.code !== "string") {
          respond(data.requestId, false, undefined, "Invalid run payload.");
          return;
        }
        runRef
          .current(data.code)
          .then((value) => respond(data.requestId, true, value))
          .catch((err: unknown) =>
            respond(
              data.requestId,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            ),
          );
        return;
      }

      if (data.type === "executor.toolCall") {
        let code: string;
        try {
          code = toolPathToCode(data.path, data.args);
        } catch (err) {
          respond(
            data.requestId,
            false,
            undefined,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        runRef
          .current(code)
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
    toolsRef.current = createToolsProxy(app, requestTrustedInteraction);
    runRef.current = createRunFn(app, requestTrustedInteraction);

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
      <div className="flex items-center justify-center h-full p-4">
        <Components.Alert variant="destructive">
          <Components.AlertCircle className="h-4 w-4" />
          <Components.AlertTitle>Error</Components.AlertTitle>
          <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {error}
          </Components.AlertDescription>
        </Components.Alert>
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
  const maxHeight = typeof config.maxHeight === "number" ? config.maxHeight : 800;
  const rendererHeight = renderer ? Math.min(renderer.height, maxHeight) : undefined;

  return (
    <Components.TooltipProvider>
      <div
        className="p-4 overflow-y-auto"
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
  app: DynamicUiShellHost;
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
