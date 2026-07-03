"use client";

import { useEveAgent, type UseEveAgentStatus } from "eve/react";
import {
  Client,
  type ClientSession,
  type HandleMessageStreamEvent,
  type InputResponse,
  type SessionState,
} from "eve/client";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WebAgentUIMessage, WebAgentWorkspaceStatusData } from "@/app/types";
import { toWebAgentMessages } from "@/lib/chat/eve-message-projection";
import {
  type OpenAgentsSendTurnPayload,
  type SessionChatSendMessageInput,
  toEveSendPayload,
  withOpenAgentsClientContext,
} from "@/lib/chat/eve-send-payload";

type ToolApprovalResponse = {
  id: string;
  approved: boolean;
  reason?: string;
};

type EvePersistencePayload = {
  events?: HandleMessageStreamEvent[];
  firstStreamIndex?: number;
  session?: SessionState;
};

export type SessionChatRuntime = {
  messages: WebAgentUIMessage[];
  error: Error | undefined;
  clearError: () => void;
  sendMessage: (message: SessionChatSendMessageInput) => Promise<void>;
  setMessages: Dispatch<SetStateAction<WebAgentUIMessage[]>>;
  status: UseEveAgentStatus;
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<void>;
  addInputResponse: (response: InputResponse) => Promise<void>;
};

type UseSessionChatRuntimeParams = {
  sessionId: string;
  chatId: string;
  initialMessages: WebAgentUIMessage[];
  initialEveEvents: HandleMessageStreamEvent[];
  initialEveSession: SessionState;
  contextLimit: number | null;
  actorUserId: string;
};

type UseSessionChatRuntimeReturn = {
  chat: SessionChatRuntime;
  stopChatStream: () => void;
  resetChatRuntime: () => void;
  workspaceStatus: WebAgentWorkspaceStatusData | null;
  clearWorkspaceStatus: () => void;
};

function approvalInputResponse(response: ToolApprovalResponse): InputResponse {
  return {
    requestId: response.id,
    optionId: response.approved ? "approve" : "deny",
    ...(response.reason ? { text: response.reason } : {}),
  };
}

export function useSessionChatRuntime({
  sessionId,
  chatId,
  initialMessages,
  initialEveEvents,
  initialEveSession,
  contextLimit,
  actorUserId,
}: UseSessionChatRuntimeParams): UseSessionChatRuntimeReturn {
  const contextLimitRef = useRef<number | null>(contextLimit);
  const initialPersistedMessages = initialEveEvents.length > 0 ? [] : initialMessages;
  const combinedMessagesRef = useRef<WebAgentUIMessage[]>(initialPersistedMessages);
  const [persistedMessages, setPersistedMessages] =
    useState<WebAgentUIMessage[]>(initialPersistedMessages);
  const [dismissedError, setDismissedError] = useState<Error | undefined>();
  const [workspaceStatus, setWorkspaceStatus] = useState<WebAgentWorkspaceStatusData | null>(null);
  const eveSessionRef = useRef<ClientSession | undefined>(undefined);
  const nextEveStreamIndexRef = useRef(initialEveEvents.length);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  if (!eveSessionRef.current) {
    eveSessionRef.current = new Client({
      host: "",
      preserveCompletedSessions: true,
    }).session(initialEveSession);
  }

  useEffect(() => {
    contextLimitRef.current = contextLimit;
  }, [contextLimit]);

  useEffect(() => {
    setPersistedMessages(initialEveEvents.length > 0 ? [] : initialMessages);
  }, [initialMessages, initialEveEvents.length]);

  useEffect(() => {
    nextEveStreamIndexRef.current = initialEveEvents.length;
  }, [chatId, initialEveEvents.length]);

  const evePersistenceEndpoint = useMemo(
    () => `/api/sessions/${encodeURIComponent(sessionId)}/chats/${encodeURIComponent(chatId)}/eve`,
    [chatId, sessionId],
  );

  const enqueueEvePersistence = useCallback(
    (payload: EvePersistencePayload) => {
      persistenceQueueRef.current = persistenceQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const response = await fetch(evePersistenceEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            throw new Error("Failed to persist Eve chat progress");
          }
        });

      void persistenceQueueRef.current.catch((error) => {
        console.error("Failed to persist Eve chat progress:", error);
      });
    },
    [evePersistenceEndpoint],
  );

  const addClientContext = useCallback(
    (payload: OpenAgentsSendTurnPayload) =>
      withOpenAgentsClientContext(payload, {
        sessionId,
        chatId,
        contextLimit: contextLimitRef.current,
        actorUserId,
      }),
    [actorUserId, chatId, sessionId],
  );

  const agent = useEveAgent({
    initialEvents: initialEveEvents,
    session: eveSessionRef.current,
    onEvent: (event) => {
      const firstStreamIndex = nextEveStreamIndexRef.current;
      nextEveStreamIndexRef.current += 1;
      enqueueEvePersistence({ events: [event], firstStreamIndex });
      setWorkspaceStatus(null);
    },
    onSessionChange: (session) => {
      enqueueEvePersistence({ session });
    },
    onFinish: (snapshot) => {
      enqueueEvePersistence({ session: snapshot.session });
      setWorkspaceStatus(null);
    },
  });

  useEffect(() => {
    setDismissedError(undefined);
  }, [agent.error]);

  const eveMessages = useMemo(() => toWebAgentMessages(agent.data.messages), [agent.data.messages]);

  const messages = useMemo(
    () => [...persistedMessages, ...eveMessages],
    [persistedMessages, eveMessages],
  );

  useEffect(() => {
    combinedMessagesRef.current = messages;
  }, [messages]);

  const resetEveProjection = agent.reset;

  const setMessages = useCallback<Dispatch<SetStateAction<WebAgentUIMessage[]>>>(
    (update) => {
      const currentMessages = combinedMessagesRef.current;
      const nextMessages = typeof update === "function" ? update(currentMessages) : update;
      setPersistedMessages(nextMessages);
      resetEveProjection();
    },
    [resetEveProjection],
  );

  const clearError = useCallback(() => {
    setDismissedError(agent.error);
  }, [agent.error]);

  const sendMessage = useCallback(
    async (message: SessionChatSendMessageInput) => {
      await agent.send(addClientContext(toEveSendPayload(message)));
    },
    [addClientContext, agent],
  );

  const addToolApprovalResponse = useCallback(
    async (response: ToolApprovalResponse) => {
      await agent.send(
        addClientContext({
          inputResponses: [approvalInputResponse(response)],
        }),
      );
    },
    [addClientContext, agent],
  );

  const addInputResponse = useCallback(
    async (response: InputResponse) => {
      await agent.send(
        addClientContext({
          inputResponses: [response],
        }),
      );
    },
    [addClientContext, agent],
  );

  const stopChatStream = useCallback(() => {
    agent.stop();
  }, [agent]);

  const resetChatRuntime = useCallback(() => {
    setDismissedError(agent.error);
    agent.reset();
  }, [agent]);

  const clearWorkspaceStatus = useCallback(() => {
    setWorkspaceStatus(null);
  }, []);

  const chat = useMemo<SessionChatRuntime>(
    () => ({
      messages,
      error: agent.error === dismissedError ? undefined : agent.error,
      clearError,
      sendMessage,
      setMessages,
      status: agent.status,
      addToolApprovalResponse,
      addInputResponse,
    }),
    [
      messages,
      agent.error,
      dismissedError,
      clearError,
      sendMessage,
      setMessages,
      agent.status,
      addToolApprovalResponse,
      addInputResponse,
    ],
  );

  return {
    chat,
    stopChatStream,
    resetChatRuntime,
    workspaceStatus,
    clearWorkspaceStatus,
  };
}
