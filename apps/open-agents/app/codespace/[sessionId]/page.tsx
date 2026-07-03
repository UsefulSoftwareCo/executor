"use client";

import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  RefreshCw,
  Square,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CodeEditorStatusResponse } from "@/app/api/sessions/[sessionId]/code-editor/route";
import { useCodespaceContext } from "./codespace-context";

type EditorState =
  | { status: "loading" }
  | { status: "starting" }
  | { status: "ready"; url: string; port: number }
  | { status: "error"; message: string }
  | { status: "stopping"; url: string; port: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body) || typeof body.error !== "string") {
    return fallback;
  }
  return body.error;
}

export default function CodespacePage() {
  const router = useRouter();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { sessionTitle, repoName, repoOwner, branch, cloneUrl } =
    useCodespaceContext();
  const [state, setState] = useState<EditorState>({ status: "loading" });
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const startedRef = useRef(false);

  const startOrCheckEditor = useCallback(async () => {
    try {
      // First check if already running
      const statusRes = await fetch(`/api/sessions/${sessionId}/code-editor`);
      if (statusRes.ok) {
        const statusBody = (await statusRes.json()) as CodeEditorStatusResponse;
        if (statusBody.running && statusBody.url) {
          setState({
            status: "ready",
            url: statusBody.url,
            port: statusBody.port,
          });
          return;
        }
      }

      // Not running, start it
      setState({ status: "starting" });
      const launchRes = await fetch(`/api/sessions/${sessionId}/code-editor`, {
        method: "POST",
      });
      const launchBody: unknown = await launchRes.json().catch(() => null);

      if (!launchRes.ok) {
        throw new Error(
          getErrorMessage(launchBody, "Failed to launch code editor"),
        );
      }

      if (
        !isRecord(launchBody) ||
        typeof launchBody.url !== "string" ||
        typeof launchBody.port !== "number"
      ) {
        throw new Error("Invalid code editor response");
      }

      setState({
        status: "ready",
        url: launchBody.url as string,
        port: launchBody.port as number,
      });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to launch code editor",
      });
    }
  }, [sessionId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startOrCheckEditor();
  }, [startOrCheckEditor]);

  const handleStop = useCallback(async () => {
    if (state.status !== "ready") return;
    setState({ status: "stopping", url: state.url, port: state.port });

    try {
      const res = await fetch(`/api/sessions/${sessionId}/code-editor`, {
        method: "DELETE",
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(getErrorMessage(body, "Failed to stop code editor"));
      }
      router.back();
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to stop code editor",
      });
    }
  }, [sessionId, state, router]);

  const handleRetry = useCallback(() => {
    setState({ status: "loading" });
    setIframeLoaded(false);
    startedRef.current = false;
    void startOrCheckEditor();
  }, [startOrCheckEditor]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Header — matches session header style */}
      <header className="border-b border-border px-3 py-1.5">
        <div className="flex items-center justify-between gap-2">
          {/* Left: back + repo info */}
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => router.back()}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Back</TooltipContent>
            </Tooltip>

            <div className="flex min-w-0 items-center gap-1.5 text-sm">
              {repoName && (
                <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
                  {cloneUrl ? (
                    /* oxlint-disable-next-line nextjs/no-html-link-for-pages */
                    <a
                      href={`https://github.com/${repoOwner}/${repoName}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 truncate font-medium text-foreground hover:underline"
                    >
                      {repoName}
                      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </a>
                  ) : (
                    <span className="truncate font-medium text-foreground">
                      {repoName}
                    </span>
                  )}
                  {branch && (
                    <>
                      <span className="text-muted-foreground/40">/</span>
                      <span className="truncate font-mono text-muted-foreground">
                        {branch}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground/40">/</span>
                </div>
              )}
              <span className="truncate font-medium text-foreground sm:font-normal sm:text-muted-foreground">
                {sessionTitle}
              </span>
            </div>
          </div>

          {/* Right: stop / retry */}
          <div className="flex shrink-0 items-center gap-1">
            {state.status === "error" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleRetry}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Retry</TooltipContent>
              </Tooltip>
            )}

            {(state.status === "ready" || state.status === "stopping") && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={state.status === "stopping"}
                    onClick={() => void handleStop()}
                  >
                    {state.status === "stopping" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {state.status === "stopping" ? "Stopping..." : "Stop editor"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="relative flex-1 overflow-hidden">
        {state.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{state.message}</p>
            <Button variant="outline" size="sm" onClick={handleRetry}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Try Again
            </Button>
          </div>
        )}

        {/* oxlint-disable react/iframe-missing-sandbox -- code-server requires both allow-scripts and allow-same-origin; cross-origin so the combination is safe */}
        {(state.status === "ready" || state.status === "stopping") && (
          <iframe
            ref={iframeRef}
            src={state.url}
            title="Code Editor"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
            allow="clipboard-read; clipboard-write"
            onLoad={() => setIframeLoaded(true)}
          />
        )}
        {/* oxlint-enable react/iframe-missing-sandbox */}

        {/* Loading overlay */}
        {state.status !== "error" &&
          (state.status === "loading" ||
            state.status === "starting" ||
            !iframeLoaded) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">
                {state.status === "loading"
                  ? "Checking editor status..."
                  : state.status === "starting"
                    ? "Starting code editor..."
                    : "Loading editor..."}
              </p>
            </div>
          )}
      </div>
    </div>
  );
}
