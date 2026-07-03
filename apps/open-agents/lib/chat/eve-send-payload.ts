import type { FileUIPart, UserContent } from "ai";
import type { SendTurnPayload } from "eve/client";
import type {
  WebAgentSnippetDataPart,
  WebAgentUIMessage,
  WebAgentUIMessagePart,
} from "@/app/types";

export type SessionChatSendMessageInput = {
  text?: string;
  files?: FileUIPart[];
  parts?: WebAgentUIMessage["parts"];
};

type OpenAgentsSnippetContext = {
  content: string;
  filename: string;
};

type OpenAgentsClientContext = {
  openAgents: {
    chatId: string;
    contextLimit?: number;
    sessionId: string;
    snippets?: OpenAgentsSnippetContext[];
  };
};

type OpenAgentsClientContextParams = {
  sessionId: string;
  chatId: string;
  contextLimit: number | null;
  metadata?: Record<string, unknown>;
  toolProfile?: readonly string[];
};

type EveUserContentPart = Exclude<UserContent, string>[number];
export type OpenAgentsSendTurnPayload = Omit<SendTurnPayload, "clientContext"> & {
  clientContext?: OpenAgentsClientContext;
};

export function openAgentsEveHeaders(params: {
  sessionId: string;
  chatId: string;
  toolProfile?: readonly string[];
}): Record<string, string> {
  return {
    "x-open-agents-session-id": params.sessionId,
    "x-open-agents-chat-id": params.chatId,
    ...(params.toolProfile && params.toolProfile.length > 0
      ? { "x-open-agents-tool-profile": params.toolProfile.join(",") }
      : {}),
  };
}

function isSnippetPart(part: WebAgentUIMessagePart): part is WebAgentSnippetDataPart {
  return part.type === "data-snippet";
}

function toEveFilePart(file: FileUIPart): Extract<EveUserContentPart, { type: "file" }> {
  return {
    type: "file",
    data: file.url,
    mediaType: file.mediaType,
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

function toEveSnippetFilePart(
  snippet: OpenAgentsSnippetContext,
): Extract<EveUserContentPart, { type: "file" }> {
  return {
    type: "file",
    data: { type: "text", text: snippet.content },
    mediaType: "text/plain",
    filename: snippet.filename,
  };
}

function buildMessageFromParts(parts: WebAgentUIMessage["parts"]): {
  message: SendTurnPayload["message"];
  snippets: OpenAgentsSnippetContext[];
} {
  const content: Exclude<UserContent, string> = [];
  const snippets: OpenAgentsSnippetContext[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "file") {
      content.push(toEveFilePart(part));
      continue;
    }

    if (isSnippetPart(part)) {
      const snippet = {
        content: part.data.content,
        filename: part.data.filename,
      };
      snippets.push(snippet);
      content.push(toEveSnippetFilePart(snippet));
    }
  }

  const [onlyContent] = content;

  if (content.length === 1 && onlyContent?.type === "text") {
    return {
      message: onlyContent.text,
      snippets,
    };
  }

  return { message: content, snippets };
}

export function toEveSendPayload(input: SessionChatSendMessageInput): OpenAgentsSendTurnPayload {
  if (input.parts) {
    const { message, snippets } = buildMessageFromParts(input.parts);
    return snippets.length > 0
      ? {
          message,
          clientContext: {
            openAgents: {
              chatId: "",
              sessionId: "",
              snippets,
            },
          } satisfies OpenAgentsClientContext,
        }
      : { message };
  }

  const files = input.files ?? [];
  if (files.length === 0) {
    return { message: input.text ?? "" };
  }

  const content: Exclude<UserContent, string> = [];
  if (input.text) {
    content.push({ type: "text", text: input.text });
  }
  content.push(...files.map(toEveFilePart));

  return { message: content };
}

export function withOpenAgentsClientContext(
  payload: OpenAgentsSendTurnPayload,
  params: OpenAgentsClientContextParams,
): SendTurnPayload {
  const snippets = payload.clientContext?.openAgents.snippets;

  return {
    ...payload,
    headers: {
      ...openAgentsEveHeaders({
        sessionId: params.sessionId,
        chatId: params.chatId,
        ...(params.toolProfile ? { toolProfile: params.toolProfile } : {}),
      }),
      ...(payload.headers ?? {}),
    },
    clientContext: {
      openAgents: {
        chatId: params.chatId,
        sessionId: params.sessionId,
        ...(params.metadata ?? {}),
        ...(snippets ? { snippets } : {}),
        ...(params.contextLimit !== null ? { contextLimit: params.contextLimit } : {}),
      },
    },
  };
}
