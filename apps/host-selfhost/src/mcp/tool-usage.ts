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
const trackedTools = new Set(["search", "invoke", "integrations", "skills", "execute"]);
const unavailable = "Tool not found or blocked by policy. Search for an available tool.";

/** Distinct connected tools counted per execution; the rest of a longer list is not retained. */
export const USAGE_EXECUTE_MAX_TARGETS = 32;

type UsageTarget = { readonly targetTool: string | null; readonly integrationSlug: string | null };
const noTarget: UsageTarget = { targetTool: null, integrationSlug: null };

/** Addresses contain identifiers only; malformed values are never retained. */
export const usageTarget = (value: unknown): UsageTarget => {
  if (typeof value !== "string" || value.length > 512) return noTarget;
  const canonical = value.startsWith("tools.") ? value : `tools.${value}`;
  const match =
    /^tools\.([a-zA-Z0-9_-]{1,64})\.(?:org|user)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.exec(canonical);
  return match && canonical.length <= 512
    ? { targetTool: canonical, integrationSlug: match[1]! }
    : noTarget;
};

const trafficClass = (extra?: MessageExtraInfo): ToolUsageEvent["trafficClass"] => {
  const value = extra?.requestInfo?.headers["x-executor-traffic-class"];
  return value === "benchmark" || value === "monitor" ? value : "agent";
};

/**
 * Connected tools a sandbox execution called, read only from the structured
 * `toolPaths` identifiers the engine already returns; never code, arguments,
 * logs or results. Malformed entries are skipped; the list is deduplicated and
 * capped. Empty when the execution called no tool or the shape is unexpected.
 */
export const usageExecuteTargets = (message: JSONRPCMessage): UsageTarget[] => {
  if (!("result" in message)) return [];
  const structured = message.result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("toolPaths" in structured))
    return [];
  const paths = structured.toolPaths;
  if (!Array.isArray(paths)) return [];
  const targets = new Map<string, UsageTarget>();
  for (const path of paths) {
    if (targets.size >= USAGE_EXECUTE_MAX_TARGETS) break;
    const target = usageTarget(path);
    if (target.targetTool !== null) targets.set(target.targetTool, target);
  }
  return [...targets.values()];
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
  // An execute call records one event per distinct connected tool it called,
  // each carrying the whole execution's status, duration and response size.
  const complete = (
    id: RequestId,
    status: ToolUsageEvent["status"],
    responseBytes: number,
    targets: readonly UsageTarget[] = [],
  ) => {
    const attempt = attempts.get(id);
    if (!attempt) return;
    attempts.delete(id);
    const durationMs = Math.max(0, performance.now() - attempt.started);
    for (const target of targets.length > 0 ? targets : [attempt]) {
      record({
        timestampMs: attempt.timestampMs,
        memberHash: attempt.memberHash,
        mcpTool: attempt.mcpTool,
        targetTool: target.targetTool,
        integrationSlug: target.integrationSlug,
        trafficClass: attempt.trafficClass,
        status,
        durationMs,
        responseBytes,
      });
    }
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
            : noTarget;
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
    if (!("id" in message) || message.id === undefined || "method" in message)
      return send(message, options);
    const attempt = attempts.get(message.id);
    if (!attempt) return send(message, options);
    let status = usageStatus(message);
    const targets = attempt.mcpTool === "execute" ? usageExecuteTargets(message) : [];
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
      complete(message.id, status, bytes, targets);
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
