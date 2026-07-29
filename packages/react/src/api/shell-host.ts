/**
 * The HTTP-backed host an embedded MCP-Apps shell talks to.
 *
 * A shell normally runs inside an MCP client, where `callServerTool` is the
 * MCP bridge. On the artifact page there is no MCP client — the console renders
 * the artifact itself — so this adapter answers the same two tool calls over
 * the ordinary executions HTTP API instead:
 *
 *   execute-action        -> POST /executions
 *   execute-action-resume -> POST /executions/:id/resume
 *
 * The shell's `proxy.ts` already turns `tools.a.b.c(...)` into `execute-action`
 * and recurses through `waiting_for_interaction` -> trusted modal -> resume, so
 * elicitation approvals work unchanged; this layer only moves bytes.
 *
 * The type is declared structurally rather than imported from
 * `@executor-js/mcp-apps-shell`: that package depends on THIS one for its
 * component barrel, so a type import here would close a package cycle that
 * turbo rejects outright. The shell's `McpAppsShellHost` is deliberately
 * structural for exactly this reason — see its declaration.
 */

import { getExecutorApiBaseUrl, getExecutorServerAuthorizationHeader } from "./server-connection";

/** The wire shape of `POST /executions` and `POST /executions/:id/resume`. */
type ExecutionResponse =
  | {
      readonly status: "completed";
      readonly text: string;
      readonly structured: unknown;
      readonly isError: boolean;
    }
  | { readonly status: "paused"; readonly text: string; readonly structured: unknown };

/** The subset of `CallToolResult` the shell reads back. */
export interface ShellToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean | undefined;
}

/** Structurally compatible with the shell package's `McpAppsShellHost`. */
export interface HttpShellHost {
  readonly callServerTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<ShellToolResult>;
  readonly getHostContext: () => { readonly theme: "light" | "dark" } | undefined;
  readonly openLink: (params: { url: string }) => Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The kernel's envelope travels in `structured`; the shell unwraps it itself.
 * A completed-and-failed execution maps to `isError` so the shell's proxy
 * throws inside the generated component instead of handing it a bogus value.
 */
const toShellToolResult = (response: ExecutionResponse): ShellToolResult => ({
  content: [{ type: "text", text: response.text }],
  structuredContent: isRecord(response.structured)
    ? response.structured
    : { result: response.structured },
  isError: response.status === "completed" && response.isError ? true : undefined,
});

/** The resume action the shell sends back after the user answers the modal. */
const isResumeAction = (value: unknown): value is "accept" | "decline" | "cancel" =>
  value === "accept" || value === "decline" || value === "cancel";

/**
 * `execute-action-resume` carries the elicitation answer as a JSON *string*
 * (the MCP tool contract is string-typed), so it is parsed back here. An
 * unparseable or non-object body becomes `undefined` rather than throwing: the
 * user's decision (accept/decline/cancel) still deserves to reach the server.
 */
const parseResumeContent = (raw: unknown): Record<string, unknown> | undefined => {
  if (typeof raw !== "string" || raw === "{}") return undefined;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.parse over a value the shell built; a malformed body must not lose the user's answer
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the resume content arrives as an opaque JSON string across the shell's postMessage bridge
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const prefersDark = (): boolean =>
  typeof globalThis.window !== "undefined" &&
  typeof globalThis.window.matchMedia === "function" &&
  globalThis.window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * Build the host. `fetch` is injectable so the seam can be tested without a
 * server; everything else is read at call time from the active server
 * connection, matching how the typed API client resolves its base URL and
 * bearer (a desktop connection carries no auth and sends none).
 */
export const createHttpShellHost = (options?: {
  readonly fetch?: typeof globalThis.fetch;
}): HttpShellHost => {
  const doFetch = options?.fetch ?? globalThis.fetch.bind(globalThis);

  const post = async (path: string, payload: Record<string, unknown>): Promise<unknown> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorization = getExecutorServerAuthorizationHeader();
    if (authorization) headers.authorization = authorization;

    const response = await doFetch(`${getExecutorApiBaseUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the shell's tool proxy is Promise-based and surfaces rejections as component errors
      throw new Error(text || `Executor API request failed with ${response.status}`);
    }
    return response.json();
  };

  return {
    getHostContext: () => ({ theme: prefersDark() ? "dark" : "light" }),

    openLink: async ({ url }) => {
      globalThis.window?.open(url, "_blank", "noopener,noreferrer");
      return {};
    },

    callServerTool: async ({ name, arguments: args }) => {
      const input = args ?? {};

      if (name === "execute-action") {
        const code = input.code;
        if (typeof code !== "string") {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: see above
          throw new Error("Missing execute-action code.");
        }
        // The artifact id travels with the call: the code addresses integrations
        // by role, and the bindings that resolve a role live on the artifact row.
        const artifactId = input.artifactId;
        return toShellToolResult(
          (await post("/executions", {
            code,
            ...(typeof artifactId === "string" ? { artifactId } : {}),
          })) as ExecutionResponse,
        );
      }

      if (name === "execute-action-resume") {
        const executionId = input.executionId;
        const action = input.action;
        if (typeof executionId !== "string") {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: see above
          throw new Error("Missing execution id.");
        }
        if (!isResumeAction(action)) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: see above
          throw new Error("Invalid resume action.");
        }
        return toShellToolResult(
          (await post(`/executions/${encodeURIComponent(executionId)}/resume`, {
            action,
            content: parseResumeContent(input.content),
          })) as ExecutionResponse,
        );
      }

      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: see above
      throw new Error(`Unsupported shell tool: ${name}`);
    },
  };
};
