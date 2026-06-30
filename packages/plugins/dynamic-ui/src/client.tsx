import { useMemo } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defineClientPlugin } from "@executor-js/sdk/client";
import { getAuthPassword, getBaseUrl } from "@executor-js/react/api/base-url";
import { DynamicUiShell, type DynamicUiShellHost } from "./shell/shell-app";

type ExecutionResponse =
  | {
      readonly status: "completed";
      readonly text: string;
      readonly structured: unknown;
      readonly isError: boolean;
    }
  | {
      readonly status: "paused";
      readonly text: string;
      readonly structured: unknown;
    };

const readInitialCode = (): string | undefined => {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("code") ?? undefined;
};

const basicAuthHeader = (): string | null => {
  const password = getAuthPassword();
  if (!password || typeof globalThis.btoa !== "function") return null;
  return `Basic ${globalThis.btoa(`executor:${password}`)}`;
};

const postJson = async (path: string, payload: Record<string, unknown>): Promise<unknown> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const basic = basicAuthHeader();
  if (basic) headers.authorization = basic;

  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Executor API request failed with ${response.status}`);
  }
  return response.json();
};

const toCallToolResult = (response: ExecutionResponse): CallToolResult => ({
  content: [{ type: "text", text: response.text }],
  structuredContent:
    typeof response.structured === "object" && response.structured !== null
      ? (response.structured as Record<string, unknown>)
      : { result: response.structured },
  isError: response.status === "completed" && response.isError ? true : undefined,
});

const parseContent = (raw: unknown): Record<string, unknown> | undefined => {
  if (raw === undefined || raw === "{}") return undefined;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const createFallbackHost = (): DynamicUiShellHost => ({
  getHostContext: () => ({
    theme:
      typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
  }),
  openLink: async ({ url }) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  },
  callServerTool: async ({ name, arguments: args }) => {
    const input = (args ?? {}) as Record<string, unknown>;

    if (name === "execute-action") {
      const code = input.code;
      if (typeof code !== "string") throw new Error("Missing execute-action code.");
      return toCallToolResult((await postJson("/executions", { code })) as ExecutionResponse);
    }

    if (name === "execute-action-resume") {
      const executionId = input.executionId;
      const action = input.action;
      if (typeof executionId !== "string") throw new Error("Missing execution id.");
      if (action !== "accept" && action !== "decline" && action !== "cancel") {
        throw new Error("Invalid resume action.");
      }
      return toCallToolResult(
        (await postJson(`/executions/${encodeURIComponent(executionId)}/resume`, {
          action,
          content: parseContent(input.content),
        })) as ExecutionResponse,
      );
    }

    throw new Error(`Unsupported shell tool: ${name}`);
  },
});

function RenderPage() {
  const initialCode = readInitialCode();
  const host = useMemo(() => createFallbackHost(), []);

  if (!initialCode) {
    return (
      <div className="mx-auto max-w-xl p-6 text-sm text-muted-foreground">
        No generated UI code was provided.
      </div>
    );
  }

  return <DynamicUiShell app={host} initialCode={initialCode} />;
}

export default defineClientPlugin({
  id: "dynamic-ui",
  pages: [{ path: "/render", component: RenderPage }],
});
