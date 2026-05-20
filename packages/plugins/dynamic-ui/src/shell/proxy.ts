import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Creates a tRPC-style recursive proxy that maps dotted tool paths
 * to execute-action calls through the MCP Apps bridge.
 *
 * Usage: tools.github.issues.create({ title: "Bug" })
 * becomes: app.callServerTool("execute-action", { code: "return await tools.github.issues.create({\"title\":\"Bug\"})" })
 */
export function createToolsProxy(
  app: App,
  requestTrustedInteraction: RequestTrustedInteraction,
): Record<string, unknown> {
  function nest(path: string[]): unknown {
    return new Proxy(function () {}, {
      get(_target, key: string) {
        if (key === "then" || key === "toJSON" || key === (Symbol.toPrimitive as unknown)) {
          return undefined;
        }
        return nest([...path, key]);
      },
      apply(_target, _thisArg, args: unknown[]) {
        const toolPath = path.join(".");
        const serializedArgs = args.length > 0 ? JSON.stringify(args[0]) : "{}";
        const code = `return await tools.${toolPath}(${serializedArgs})`;

        console.log("[executor-proxy] calling:", code);

        return app
          .callServerTool({
            name: "execute-action",
            arguments: { code },
          })
          .then((r) => resolveToolResult(app, r, requestTrustedInteraction));
      },
    });
  }

  return nest([]) as Record<string, unknown>;
}

/**
 * Creates the `run()` escape hatch for multi-step tool composition.
 *
 * Usage: const result = await run(`
 *   const me = await tools.github.users.me()
 *   return await tools.github.issues.create({ assignee: me.login, ... })
 * `)
 */
export function createRunFn(
  app: App,
  requestTrustedInteraction: RequestTrustedInteraction,
): (code: string) => Promise<unknown> {
  return (code: string) =>
    app
      .callServerTool({
        name: "execute-action",
        arguments: { code },
      })
      .then((r) => resolveToolResult(app, r, requestTrustedInteraction));
}

async function resolveToolResult(
  app: App,
  result: CallToolResult,
  requestTrustedInteraction: RequestTrustedInteraction,
): Promise<unknown> {
  console.log(
    "[executor-proxy] raw result:",
    JSON.stringify({
      isError: result.isError,
      structuredContent: result.structuredContent,
      text: result.content?.find((c) => c.type === "text")?.text,
    }),
  );

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

  const unwrapped = unwrapResult(structured) ?? parseTextContent(result);
  console.log("[executor-proxy] unwrapped:", JSON.stringify(unwrapped));
  return unwrapped;
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
