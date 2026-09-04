import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolCallHost = {
  readonly callServerTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult>;
};

export type TrustedInteraction = {
  executionId: string;
  pauseSequence?: number;
  interaction: {
    kind?: unknown;
    message?: unknown;
    url?: unknown;
    requestedSchema?: unknown;
    /**
     * The paused call's tool address (`executor.coreTools.policies.create`),
     * put on the wire by `formatPausedExecution`. It is the only stable
     * identity a pause carries — the execution id is per-call — so it is what
     * the shell keys a remembered approval by.
     */
    address?: unknown;
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
 *     return await tools.<ident>("<role>")?(.<ident>)*(<JSON>)
 *
 * A single proxy-shaped tool call, nothing else — no statements, no loops, no
 * composition. The server parses `execute-action` against exactly this shape
 * (`parseToolCallCode` in `@executor-js/host-mcp`), so an iframe cannot smuggle
 * arbitrary code through the app channel even though the shell UI never offers
 * a way to write any. `tool-call-grammar.pin.test.ts` pins the two together.
 *
 * The path's head is an INTEGRATION, and the optional role tags which of the
 * artifact's connections for that integration to use. Neither the tier nor the
 * connection name is ever on this wire: the server resolves them from the
 * bindings stored on the artifact row. That is the whole point of the short
 * form — an iframe that fabricated an address would be naming something the
 * artifact was never bound to, and the server would refuse it.
 *
 * Role and args are both `JSON.stringify` output, so the emission stays
 * parseable and a role containing a quote cannot break out of the call.
 */
export function toolCallCode(
  path: readonly string[],
  args: readonly unknown[],
  role?: string,
): string {
  if (path.length === 0) throw new Error("Invalid tool path.");
  const parts = path.map((part) => {
    if (typeof part !== "string" || !TOOL_PATH_SEGMENT.test(part)) {
      throw new Error("Invalid tool path.");
    }
    return part;
  });
  if (role !== undefined && (typeof role !== "string" || role.length === 0)) {
    throw new Error("Invalid tool role.");
  }
  const [head, ...rest] = parts;
  const tag = role === undefined ? "" : `(${JSON.stringify(role)})`;
  const trailer = rest.length > 0 ? `.${rest.join(".")}` : "";
  return `return await tools.${head}${tag}${trailer}(${JSON.stringify(args[0] ?? {})})`;
}

/**
 * Calls one tool through the MCP Apps bridge, resolving any shell-owned
 * approval the execution pauses for.
 *
 * `tools.github.issues.create({ title: "Bug" })` in the generated iframe arrives
 * here as `(["github","issues","create"], [{ title: "Bug" }])` and becomes
 * `execute-action` with
 * `code: "return await tools.github.issues.create({\"title\":\"Bug\"})"`.
 *
 * `artifactId` rides alongside the code because the server cannot resolve the
 * call without it: the path names an integration role, and the bindings that
 * turn a role into a connection live on the artifact row. It is supplied by the
 * host (from the tool input the artifact was delivered with), never by the
 * generated component — and the server checks the caller owns it.
 */
export function createToolCaller(
  app: ToolCallHost,
  requestTrustedInteraction: RequestTrustedInteraction,
  getArtifactId?: () => string | undefined,
): (path: readonly string[], args: readonly unknown[], role?: string) => Promise<unknown> {
  return (path, args, role) => {
    const artifactId = getArtifactId?.();
    return app
      .callServerTool({
        name: "execute-action",
        arguments: {
          code: toolCallCode(path, args, role),
          ...(artifactId === undefined ? {} : { artifactId }),
        },
      })
      .then((r) => resolveToolResult(app, r, requestTrustedInteraction));
  };
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
        ...(pending.pauseSequence === undefined ? {} : { pauseSequence: pending.pauseSequence }),
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
  return {
    executionId: structured.executionId,
    ...(typeof structured.pauseSequence === "number"
      ? { pauseSequence: structured.pauseSequence }
      : {}),
    interaction,
  };
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
