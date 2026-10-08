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
// Engine-issued opaque IDs only. Never retain arbitrary resume arguments.
const executionId = (value: unknown): string | undefined =>
  typeof value === "string" && /^exec_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;

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

type UsageExecuteTarget = UsageTarget & { readonly status?: ToolUsageEvent["status"] };
const outcomeSeverity = { ok: 0, error: 1, blocked: 2 } as const;

/**
 * Connected tools a sandbox execution attempted, read only from structured
 * identifiers and enum outcomes; never code, arguments, logs or results.
 * Older engines provide successful `toolPaths` without per-target outcomes.
 */
export const usageExecuteTargets = (message: JSONRPCMessage): UsageExecuteTarget[] => {
  if (!("result" in message)) return [];
  const structured = message.result.structuredContent;
  if (typeof structured !== "object" || structured === null) return [];
  const calls = "toolCalls" in structured ? structured.toolCalls : undefined;
  const paths = "toolPaths" in structured ? structured.toolPaths : undefined;
  const targets = new Map<string, UsageExecuteTarget>();
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (
        typeof call !== "object" ||
        call === null ||
        (call.status !== "ok" && call.status !== "error" && call.status !== "blocked")
      )
        continue;
      const status: "ok" | "error" | "blocked" = call.status;
      const target = usageTarget(call.path);
      if (target.targetTool === null) continue;
      const previous = targets.get(target.targetTool);
      if (
        previous
          ? outcomeSeverity[status] > outcomeSeverity[previous.status ?? "ok"]
          : targets.size < USAGE_EXECUTE_MAX_TARGETS
      ) {
        targets.set(target.targetTool, { ...target, status });
      }
    }
  }
  if (Array.isArray(paths)) {
    for (const path of paths) {
      const target = usageTarget(path);
      if (
        target.targetTool !== null &&
        !targets.has(target.targetTool) &&
        targets.size < USAGE_EXECUTE_MAX_TARGETS
      )
        targets.set(target.targetTool, target);
    }
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
  const paused = new Map<string, Attempt>();
  const resumes = new Map<RequestId, string>();
  const dropOldest = <K, V>(pending: Map<K, V>) => {
    if (pending.size < TOOL_USAGE_MAX_PENDING) return;
    pending.delete(pending.keys().next().value!);
    onDrop();
  };
  // An execute call records one event per distinct connected tool it called,
  // each carrying its outcome and the whole execution's duration and response size.
  const recordAttempt = (
    attempt: Attempt,
    status: ToolUsageEvent["status"],
    responseBytes: number,
    targets: readonly UsageExecuteTarget[] = [],
  ) => {
    const durationMs = Math.max(0, performance.now() - attempt.started);
    for (const target of targets.length > 0 ? targets : [attempt]) {
      record({
        timestampMs: attempt.timestampMs,
        memberHash: attempt.memberHash,
        mcpTool: attempt.mcpTool,
        targetTool: target.targetTool,
        integrationSlug: target.integrationSlug,
        trafficClass: attempt.trafficClass,
        // A script or transport failure makes every attributed row an execution error.
        status:
          status === "error"
            ? "error"
            : (("status" in target ? target.status : undefined) ?? status),
        durationMs,
        responseBytes,
      });
    }
  };
  const complete = (
    id: RequestId,
    status: ToolUsageEvent["status"],
    bytes: number,
    targets: readonly UsageExecuteTarget[] = [],
  ) => {
    const attempt = attempts.get(id);
    if (!attempt) return;
    attempts.delete(id);
    recordAttempt(attempt, status, bytes, targets);
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
        (trackedTools.has(message.params.name) || message.params.name === "resume")
      ) {
        const args = message.params.arguments;
        if (message.params.name === "resume") {
          const id =
            typeof args === "object" && args !== null && "executionId" in args
              ? executionId(args.executionId)
              : undefined;
          // Only the session that observed execute can attribute its resume.
          if (id && paused.has(id)) {
            dropOldest(resumes);
            resumes.set(message.id, id);
          }
          receive?.(message, extra);
          return;
        }
        const tool = message.params.name as ToolUsageEvent["mcpTool"];
        const target =
          tool === "invoke" && typeof args === "object" && args !== null && "tool" in args
            ? usageTarget(args.tool)
            : noTarget;
        // Drop incomplete observations rather than invent a completion status.
        dropOldest(attempts);
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
    const resumeId = resumes.get(message.id);
    const attempt = resumeId === undefined ? attempts.get(message.id) : paused.get(resumeId);
    if (!attempt) {
      resumes.delete(message.id);
      return send(message, options);
    }
    const structured = "result" in message ? message.result.structuredContent : undefined;
    const executionStatus =
      typeof structured === "object" && structured !== null && "status" in structured
        ? structured.status
        : undefined;
    const waiting =
      attempt.mcpTool === "execute" &&
      (executionStatus === "waiting_for_interaction" ||
        executionStatus === "user_approval_required");
    const nextId =
      waiting &&
      typeof structured === "object" &&
      structured !== null &&
      "executionId" in structured
        ? executionId(structured.executionId)
        : undefined;
    // Register the pause before send: an in-memory client can submit resume
    // as soon as it receives this response, before send's promise settles.
    if (waiting) {
      if (resumeId === undefined) attempts.delete(message.id);
      else paused.delete(resumeId);
      if (nextId) {
        dropOldest(paused);
        paused.set(nextId, attempt);
      } else onDrop();
    }
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
      resumes.delete(message.id);
      // A concurrent or cached resume may replay the same result. The first
      // response owns the transition; later responses never record it again.
      const owns =
        resumeId === undefined
          ? attempts.get(message.id) === attempt
          : paused.get(resumeId) === attempt;
      if (owns && !waiting) {
        if (resumeId === undefined) {
          complete(message.id, status, bytes, targets);
        } else if (executionStatus === "completed" || executionStatus === "error") {
          paused.delete(resumeId);
          recordAttempt(attempt, status, bytes, targets);
        }
        // Resume validation errors and missing decisions leave the execution
        // paused. They are not another execution or its terminal outcome.
      }
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    for (const id of attempts.keys()) complete(id, "error", 0);
    // Closing a paused session provides no terminal connected-tool outcomes.
    // Report observation loss instead of inventing null-target success/error.
    for (let count = 0; count < paused.size; count++) onDrop();
    paused.clear();
    resumes.clear();
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
