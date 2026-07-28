import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolCallHost = {
  readonly callServerTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult>;
};

export type TrustedInteraction = {
  executionId: string;
  interaction: {
    kind?: unknown;
    message?: unknown;
    url?: unknown;
    requestedSchema?: unknown;
  };
};

export type TrustedInteractionResponse = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type RequestTrustedInteraction = (
  interaction: TrustedInteraction,
) => Promise<TrustedInteractionResponse>;

const TOOL_PATH_SEGMENT = /^[A-Za-z_$][\w$]*$/;

/**
 * The ONE grammar the shell ever puts on the `execute-action` wire:
 *
 *     return await tools.<ident>(.<ident>)*(<JSON>)
 *
 * A single proxy-shaped tool call, nothing else — no statements, no loops, no
 * composition. The server parses `execute-action` against exactly this shape
 * (`parseToolCallCode` in `@executor-js/host-mcp`), so an iframe cannot smuggle
 * arbitrary code through the app channel even though the shell UI never offers
 * a way to write any. `tool-call-grammar.pin.test.ts` pins the two together.
 *
 * Args are `JSON.stringify` output, so the whole emission stays parseable.
 */
export function toolCallCode(path: readonly string[], args: readonly unknown[]): string {
  if (path.length === 0) throw new Error("Invalid tool path.");
  const parts = path.map((part) => {
    if (typeof part !== "string" || !TOOL_PATH_SEGMENT.test(part)) {
      throw new Error("Invalid tool path.");
    }
    return part;
  });
  return `return await tools.${parts.join(".")}(${JSON.stringify(args[0] ?? {})})`;
}

/**
 * Calls one tool through the MCP Apps bridge, resolving any shell-owned
 * approval the execution pauses for.
 *
 * `tools.github.issues.create({ title: "Bug" })` in the generated iframe arrives
 * here as `(["github","issues","create"], [{ title: "Bug" }])` and becomes
 * `execute-action` with
 * `code: "return await tools.github.issues.create({\"title\":\"Bug\"})"`.
 */
export function createToolCaller(
  app: ToolCallHost,
  requestTrustedInteraction: RequestTrustedInteraction,
): (path: readonly string[], args: readonly unknown[]) => Promise<unknown> {
  return (path, args) =>
    app
      .callServerTool({
        name: "execute-action",
        arguments: { code: toolCallCode(path, args) },
      })
      .then((r) => resolveToolResult(app, r, requestTrustedInteraction));
}

async function resolveToolResult(
  app: ToolCallHost,
  result: CallToolResult,
  requestTrustedInteraction: RequestTrustedInteraction,
): Promise<unknown> {
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text ?? "Tool call failed";
    throw new Error(msg);
  }

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const pending = parseTrustedInteraction(structured);
  if (pending) {
    const response = await requestTrustedInteraction(pending);
    const resumed = await app.callServerTool({
      name: "execute-action-resume",
      arguments: {
        executionId: pending.executionId,
        action: response.action,
        content: JSON.stringify(response.content ?? {}),
      },
    });
    return resolveToolResult(app, resumed, requestTrustedInteraction);
  }

  return unwrapResult(structured) ?? parseTextContent(result);
}

function parseTrustedInteraction(
  structured: Record<string, unknown> | undefined,
): TrustedInteraction | null {
  if (!structured || structured.status !== "waiting_for_interaction") return null;
  if (typeof structured.executionId !== "string") return null;
  const interaction =
    typeof structured.interaction === "object" &&
    structured.interaction !== null &&
    !Array.isArray(structured.interaction)
      ? (structured.interaction as TrustedInteraction["interaction"])
      : {};
  return { executionId: structured.executionId, interaction };
}

/**
 * Unwrap execution result. The kernel wraps results as
 * `{ status: "completed", result: <actual>, logs: [...] }`.
 * Return just the inner result value.
 */
function unwrapResult(structured: Record<string, unknown> | undefined | null): unknown {
  if (
    structured &&
    typeof structured === "object" &&
    "status" in structured &&
    "result" in structured
  ) {
    return structured.result;
  }
  return structured;
}

function parseTextContent(r: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
