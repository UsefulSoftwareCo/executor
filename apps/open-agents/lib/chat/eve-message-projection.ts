import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  HandleMessageStreamEvent,
} from "eve/client";
import { defaultMessageReducer } from "eve/client";
import type { OpenAgentsUITools } from "@/lib/chat/tool-contracts";
import type { WebAgentUIMessage, WebAgentUIMessagePart } from "@/app/types";

export type EveMessageEventRow = {
  event: HandleMessageStreamEvent;
  createdAt: Date;
};

export type WebAgentMessageWithTiming = {
  message: WebAgentUIMessage;
  durationMs: number | null;
  createdAt: Date | null;
};

const KNOWN_EVE_TOOLS = new Set<keyof OpenAgentsUITools>([
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "write_file",
]);

function authorizationText(part: EveAuthorizationPart): string {
  if (part.state === "completed") {
    return part.outcome === "authorized"
      ? `${part.displayName} connected.`
      : `${part.displayName} authorization ${part.outcome}.`;
  }

  const lines = [part.description];
  if (part.authorization?.url) {
    lines.push(`[Sign in with ${part.displayName}](${part.authorization.url})`);
  }
  if (part.authorization?.userCode) {
    lines.push(`Code: ${part.authorization.userCode}`);
  }
  return lines.join("\n\n");
}

function toWebAgentMessagePart(
  part: EveMessage["parts"][number],
): WebAgentUIMessagePart | null {
  switch (part.type) {
    case "text":
    case "reasoning":
      return {
        type: part.type,
        text: part.text,
        ...(part.state ? { state: part.state } : {}),
      };
    case "step-start":
      return { type: "step-start" };
    case "dynamic-tool":
      return toDynamicToolPart(part);
    case "authorization":
      return {
        type: "text",
        text: authorizationText(part),
        state: part.state === "completed" ? "done" : "streaming",
      };
  }
}

function toToolPartBase(part: EveDynamicToolPart) {
  if (KNOWN_EVE_TOOLS.has(part.toolName as keyof OpenAgentsUITools)) {
    return {
      type: `tool-${part.toolName}`,
      toolCallId: part.toolCallId,
      ...(part.toolMetadata ? { toolMetadata: part.toolMetadata } : {}),
    };
  }

  return {
    type: "dynamic-tool",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...(part.toolMetadata ? { toolMetadata: part.toolMetadata } : {}),
  };
}

function toDynamicToolPart(part: EveDynamicToolPart): WebAgentUIMessagePart {
  const base = toToolPartBase(part);

  switch (part.state) {
    case "input-streaming":
      return {
        ...base,
        state: part.state,
        input: part.input,
      } as WebAgentUIMessagePart;
    case "input-available":
      return {
        ...base,
        state: part.state,
        input: part.input,
      } as WebAgentUIMessagePart;
    case "approval-requested":
      return {
        ...base,
        state: part.state,
        input: part.input,
        approval: part.approval,
      } as WebAgentUIMessagePart;
    case "approval-responded":
      return {
        ...base,
        state: part.state,
        input: part.input,
        approval: {
          ...part.approval,
          approved: part.approval.approved === true,
        },
      } as WebAgentUIMessagePart;
    case "output-available":
      return {
        ...base,
        state: part.state,
        input: part.input,
        output: part.output,
        ...(part.approval ? { approval: part.approval } : {}),
      } as WebAgentUIMessagePart;
    case "output-error":
      return {
        ...base,
        state: part.state,
        input: part.input,
        errorText: part.errorText,
        ...(part.approval ? { approval: part.approval } : {}),
      } as WebAgentUIMessagePart;
    case "output-denied":
      return {
        ...base,
        state: part.state,
        input: part.input,
        approval: part.approval,
      } as WebAgentUIMessagePart;
  }
}

export function toWebAgentMessages(
  messages: readonly EveMessage[],
): WebAgentUIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap((part) => {
      const projected = toWebAgentMessagePart(part);
      return projected ? [projected] : [];
    }),
  }));
}

export function toWebAgentMessagesFromEvents(
  events: readonly HandleMessageStreamEvent[],
): WebAgentUIMessage[] {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();

  for (const event of events) {
    data = reducer.reduce(data, event);
  }

  return toWebAgentMessages(data.messages);
}

export function toWebAgentMessagesFromEventRows(
  rows: readonly EveMessageEventRow[],
): WebAgentUIMessage[] {
  return toWebAgentMessagesFromEvents(rows.map((row) => row.event));
}

export function toWebAgentMessagesWithTimingFromEventRows(
  rows: readonly EveMessageEventRow[],
): WebAgentMessageWithTiming[] {
  const userMessageCreatedAt = new Map<string, Date>();
  const assistantMessageCreatedAt = new Map<string, Date>();

  for (const row of rows) {
    const { event } = row;
    if (event.type === "message.received") {
      userMessageCreatedAt.set(`${event.data.turnId}:user`, row.createdAt);
    }

    if (
      event.type === "message.completed" &&
      event.data.finishReason !== "tool-calls"
    ) {
      assistantMessageCreatedAt.set(
        `${event.data.turnId}:assistant`,
        row.createdAt,
      );
    }
  }

  return toWebAgentMessagesFromEventRows(rows).map((message) => {
    if (message.role === "user") {
      return {
        message,
        durationMs: null,
        createdAt: userMessageCreatedAt.get(message.id) ?? null,
      };
    }

    const createdAt = assistantMessageCreatedAt.get(message.id) ?? null;
    const turnId = message.id.endsWith(":assistant")
      ? message.id.slice(0, -":assistant".length)
      : null;
    const userCreatedAt = turnId
      ? userMessageCreatedAt.get(`${turnId}:user`)
      : undefined;

    return {
      message,
      durationMs:
        createdAt && userCreatedAt
          ? createdAt.getTime() - userCreatedAt.getTime()
          : null,
      createdAt,
    };
  });
}

export function getLastUserMessageCreatedAtFromEventRows(
  rows: readonly EveMessageEventRow[],
): Date | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.event.type === "message.received") {
      return row.createdAt;
    }
  }

  return null;
}
