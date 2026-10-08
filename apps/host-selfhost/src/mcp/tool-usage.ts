import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TOOL_USAGE_MAX_PENDING, type ToolUsageEvent } from "./tool-usage-store";

type Attempt = Omit<ToolUsageEvent, "status" | "durationMs" | "responseBytes"> & {
  readonly started: number;
};
const trackedTools = new Set(["search", "invoke", "integrations", "skills"]);
const unavailable = "Tool not found or blocked by policy. Search for an available tool.";

/** Addresses contain identifiers only; malformed values are never retained. */
export const usageTarget = (
  value: unknown,
): { targetTool: string | null; integrationSlug: string | null } => {
  if (typeof value !== "string" || value.length > 512)
    return { targetTool: null, integrationSlug: null };
  const canonical = value.startsWith("tools.") ? value : `tools.${value}`;
  const match =
    /^tools\.([a-zA-Z0-9_-]{1,64})\.(?:org|user)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.exec(canonical);
  return match && canonical.length <= 512
    ? { targetTool: canonical, integrationSlug: match[1]! }
    : { targetTool: null, integrationSlug: null };
};

const trafficClass = (extra?: MessageExtraInfo): ToolUsageEvent["trafficClass"] => {
  const value = extra?.requestInfo?.headers["x-executor-traffic-class"];
  return value === "benchmark" || value === "monitor" ? value : "agent";
};

export const usageStatus = (message: JSONRPCMessage): ToolUsageEvent["status"] => {
  if ("error" in message) return "error";
  if (!("result" in message) || message.result.isError !== true) return "ok";
  const structured = message.result.structuredContent;
  if (
    typeof structured === "object" &&
    structured !== null &&
    "error" in structured &&
    typeof structured.error === "object" &&
    structured.error !== null &&
    "code" in structured.error &&
    structured.error.code === "tool_blocked"
  )
    return "blocked";
  const content = message.result.content;
  // This fixed denial also covers unknown/hidden tools; never expose which case.
  if (
    Array.isArray(content) &&
    content.some(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "text" in item &&
        typeof item.text === "string" &&
        (item.text === unavailable || item.text.startsWith("Error: Tool blocked by policy ")),
    )
  )
    return "blocked";
  return "error";
};

/** Observe the SDK transport through public callbacks, including validation failures. */
export const observeToolUsageTransport = (
  transport: Transport,
  memberHash: string,
  record: (event: ToolUsageEvent) => void,
  onDrop: () => void = () => {},
): void => {
  const attempts = new Map<RequestId, Attempt>();
  const complete = (id: RequestId, status: ToolUsageEvent["status"], responseBytes: number) => {
    const attempt = attempts.get(id);
    if (!attempt) return;
    attempts.delete(id);
    record({
      timestampMs: attempt.timestampMs,
      memberHash: attempt.memberHash,
      mcpTool: attempt.mcpTool,
      targetTool: attempt.targetTool,
      integrationSlug: attempt.integrationSlug,
      trafficClass: attempt.trafficClass,
      status,
      durationMs: Math.max(0, performance.now() - attempt.started),
      responseBytes,
    });
  };
  const start = transport.start.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (
        "method" in message &&
        message.method === "tools/call" &&
        "id" in message &&
        message.params &&
        typeof message.params.name === "string" &&
        trackedTools.has(message.params.name)
      ) {
        const tool = message.params.name as ToolUsageEvent["mcpTool"];
        const args = message.params.arguments;
        const target =
          tool === "invoke" && typeof args === "object" && args !== null && "tool" in args
            ? usageTarget(args.tool)
            : { targetTool: null, integrationSlug: null };
        // Drop incomplete observations rather than invent a completion status.
        if (attempts.size >= TOOL_USAGE_MAX_PENDING) {
          attempts.delete(attempts.keys().next().value!);
          onDrop();
        }
        attempts.set(message.id, {
          timestampMs: Date.now(),
          started: performance.now(),
          memberHash,
          mcpTool: tool,
          ...target,
          trafficClass: trafficClass(extra),
        });
      }
      receive?.(message, extra);
    };
    await start();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (
      !("id" in message) ||
      message.id === undefined ||
      "method" in message ||
      !attempts.has(message.id)
    )
      return send(message, options);
    let status = usageStatus(message);
    let bytes = 0;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: metrics sizing must never alter SDK results, even for non-serializable responses
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      // The actual transport remains responsible for serializing its response.
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve transport failures and count the attempted dispatch
    try {
      await send(message, options);
    } catch (error) {
      status = "error";
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve the original SDK transport rejection
      throw error;
    } finally {
      complete(message.id, status, bytes);
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    for (const id of attempts.keys()) complete(id, "error", 0);
    close?.();
  };
};

export const observeToolUsageServer = (
  server: McpServer,
  memberHash: string,
  record: (event: ToolUsageEvent) => void,
  onDrop: () => void = () => {},
): void => {
  const connect = server.connect.bind(server);
  server.connect = (transport) => {
    observeToolUsageTransport(transport, memberHash, record, onDrop);
    return connect(transport);
  };
};
