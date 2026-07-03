import { AuthzError, requireChatAccess, requireSessionAccess } from "@open-agents/authz";
import type { getChatById, getChatSummariesBySessionId } from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionByIdCached>>>;
type ChatRecord = NonNullable<Awaited<ReturnType<typeof getChatById>>>;
type ChatSummary = Awaited<ReturnType<typeof getChatSummariesBySessionId>>[number];

export type ReadableChatPageContext =
  | {
      ok: true;
      sessionRecord: SessionRecord;
      chat: ChatRecord;
    }
  | {
      ok: false;
      reason: "session-not-found" | "chat-not-found" | "forbidden";
    };

export async function getReadableChatPageContext({
  userId,
  sessionId,
  chatId,
  loadChat,
}: {
  userId: string;
  sessionId: string;
  chatId: string;
  loadChat: (chatId: string, sessionId: string) => Promise<ChatRecord | undefined>;
}): Promise<ReadableChatPageContext> {
  const [sessionRecord, chat] = await Promise.all([
    getSessionByIdCached(sessionId),
    loadChat(chatId, sessionId),
  ]);

  if (!sessionRecord) {
    return { ok: false, reason: "session-not-found" };
  }

  if (!chat || chat.sessionId !== sessionId) {
    return { ok: false, reason: "chat-not-found" };
  }

  try {
    await requireChatAccess({ kind: "user", userId }, chatId, "read");
  } catch (error) {
    if (error instanceof AuthzError) {
      return {
        ok: false,
        reason: error.status === 404 ? "chat-not-found" : "forbidden",
      };
    }
    throw error;
  }

  return { ok: true, sessionRecord, chat };
}

export async function canRenderSessionShell({
  userId,
  sessionId,
  accessibleChats,
}: {
  userId: string;
  sessionId: string;
  accessibleChats: readonly ChatSummary[];
}): Promise<boolean> {
  try {
    await requireSessionAccess({ kind: "user", userId }, sessionId, "read");
    return true;
  } catch (error) {
    if (error instanceof AuthzError && error.status === 403) {
      return accessibleChats.length > 0;
    }
    throw error;
  }
}
