import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "./client";
import { getEveChatStreamingStatuses } from "./eve-chat-sessions";
import {
  chatReads,
  chats,
  eveChatEvents,
  type NewChat,
  type NewChatRead,
  type NewSession,
  type NewShare,
  sessions,
  shares,
} from "./schema";

export {
  appendEveChatEvents,
  buildEveChatEventRows,
  createInitialEveChatSessionState,
  getEveChatEventRows,
  getEveChatEvents,
  getEveChatSessionSnapshot,
  getEveChatSessionState,
  getEveChatStreamingStatuses,
  getIsEveChatStreaming,
  getLatestEveChatEvent,
  isEveChatEventStreaming,
  persistEveChatSessionPatch,
  persistEveChatSessionProgress,
  resetEveChatSessionPersistence,
  toEveChatSessionSnapshot,
  upsertEveChatSessionState,
} from "./eve-chat-sessions";
export type {
  EveChatEventWithCreatedAtRow,
  EveChatEventRow,
  EveChatSessionSnapshot,
  EveChatSessionStateRow,
} from "./eve-chat-sessions";

export async function createSession(data: NewSession) {
  const [session] = await db.insert(sessions).values(data).returning();
  if (!session) {
    throw new Error("Failed to create session");
  }
  return session;
}

interface CreateSessionWithInitialChatInput {
  session: NewSession;
  initialChat: Pick<NewChat, "id" | "title" | "modelId">;
}

export async function createSessionWithInitialChat(input: CreateSessionWithInitialChatInput) {
  return db.transaction(async (tx) => {
    const [session] = await tx.insert(sessions).values(input.session).returning();
    if (!session) {
      throw new Error("Failed to create session");
    }

    const [chat] = await tx
      .insert(chats)
      .values({
        id: input.initialChat.id,
        sessionId: session.id,
        title: input.initialChat.title,
        modelId: input.initialChat.modelId,
      })
      .returning();
    if (!chat) {
      throw new Error("Failed to create chat");
    }

    return { session, chat };
  });
}

export async function getSessionById(sessionId: string) {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  return session;
}

export async function getShareById(shareId: string) {
  return db.query.shares.findFirst({
    where: eq(shares.id, shareId),
  });
}

export async function getShareByChatId(chatId: string) {
  return db.query.shares.findFirst({
    where: eq(shares.chatId, chatId),
  });
}

export async function createShareIfNotExists(data: NewShare) {
  const [share] = await db
    .insert(shares)
    .values(data)
    .onConflictDoNothing({ target: shares.chatId })
    .returning();

  if (share) {
    return share;
  }

  return getShareByChatId(data.chatId);
}

export async function deleteShareByChatId(chatId: string) {
  await db.delete(shares).where(eq(shares.chatId, chatId));
}

export async function getSessionsByUserId(userId: string) {
  const records = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    orderBy: [desc(sessions.createdAt)],
  });

  return records;
}

export async function countSessionsByUserId(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  return result?.count ?? 0;
}

export async function countUserMessagesByUserId(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(eveChatEvents)
    .innerJoin(chats, eq(chats.id, eveChatEvents.chatId))
    .innerJoin(sessions, eq(sessions.id, chats.sessionId))
    .where(
      and(eq(sessions.userId, userId), eq(eveChatEvents.eventType, "message.received")),
    );

  return result?.count ?? 0;
}

type SessionSidebarFields = Pick<
  typeof sessions.$inferSelect,
  | "id"
  | "title"
  | "status"
  | "repoOwner"
  | "repoName"
  | "branch"
  | "linesAdded"
  | "linesRemoved"
  | "prNumber"
  | "prStatus"
  | "createdAt"
>;

export type SessionWithUnread = SessionSidebarFields & {
  hasUnread: boolean;
  hasStreaming: boolean;
  latestChatId: string | null;
  lastActivityAt: Date;
};

type GetSessionsWithUnreadByUserIdOptions = {
  status?: "all" | "active" | "archived";
  limit?: number;
  offset?: number;
};

/**
 * Returns sessions for a user, each annotated with a `hasUnread` flag
 * that is true when any chat in the session has unread assistant messages.
 *
 * The sidebar only needs lightweight fields, so we intentionally avoid
 * selecting heavyweight JSON columns like `sandboxState` and `cachedDiff`.
 */
export async function getSessionsWithUnreadByUserId(
  userId: string,
  options?: GetSessionsWithUnreadByUserIdOptions,
): Promise<SessionWithUnread[]> {
  const status = options?.status ?? "all";
  const statusFilter =
    status === "active"
      ? ne(sessions.status, "archived")
      : status === "archived"
        ? eq(sessions.status, "archived")
        : undefined;

  const baseQuery = db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      repoOwner: sessions.repoOwner,
      repoName: sessions.repoName,
      branch: sessions.branch,
      linesAdded: sessions.linesAdded,
      linesRemoved: sessions.linesRemoved,
      prNumber: sessions.prNumber,
      prStatus: sessions.prStatus,
      createdAt: sessions.createdAt,
      lastActivityAt: sql<Date>`COALESCE(MAX(${chats.updatedAt}), ${sessions.createdAt})`,
      hasUnread: sql<boolean>`COALESCE(BOOL_OR(
        CASE
          WHEN ${chats.lastAssistantMessageAt} IS NULL THEN false
          WHEN ${chatReads.lastReadAt} IS NULL THEN true
          WHEN ${chats.lastAssistantMessageAt} > ${chatReads.lastReadAt} THEN true
          ELSE false
        END
      ), false)`,
      chatIds: sql<string[]>`COALESCE(
        ARRAY_AGG(${chats.id}) FILTER (WHERE ${chats.id} IS NOT NULL),
        ARRAY[]::text[]
      )`,
      latestChatId: sql<string | null>`(
        ARRAY_AGG(${chats.id} ORDER BY ${chats.updatedAt} DESC, ${chats.createdAt} DESC)
        FILTER (WHERE ${chats.id} IS NOT NULL)
      )[1]`,
    })
    .from(sessions)
    .leftJoin(chats, eq(chats.sessionId, sessions.id))
    .leftJoin(chatReads, and(eq(chatReads.chatId, chats.id), eq(chatReads.userId, userId)))
    .where(
      statusFilter ? and(eq(sessions.userId, userId), statusFilter) : eq(sessions.userId, userId),
    )
    .groupBy(sessions.id)
    .orderBy(desc(sessions.createdAt));

  const withOffset =
    typeof options?.offset === "number" && options.offset > 0
      ? baseQuery.offset(options.offset)
      : baseQuery;

  const rows =
    typeof options?.limit === "number" ? await withOffset.limit(options.limit) : await withOffset;

  const streamingStatuses = await getEveChatStreamingStatuses(
    rows.flatMap((row) => row.chatIds),
  );

  return rows.map(({ chatIds, ...row }) => ({
    ...row,
    hasStreaming: chatIds.some((chatId) => streamingStatuses.get(chatId) ?? false),
  }));
}

export async function getArchivedSessionCountByUserId(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.status, "archived")));

  return result?.count ?? 0;
}

/**
 * Returns a Set of all session titles for a given user.
 * Used to avoid duplicate random city names when creating new sessions.
 */
export async function getUsedSessionTitles(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ title: sessions.title })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return new Set(rows.map((r) => r.title));
}

export async function updateSession(
  sessionId: string,
  data: Partial<Omit<NewSession, "id" | "userId" | "createdAt">>,
) {
  const [session] = await db
    .update(sessions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();

  return session;
}

/**
 * Atomically claims the session lifecycle lease when no run is currently
 * recorded. Returns true when the claim succeeds.
 */
export async function claimSessionLifecycleRunId(sessionId: string, runId: string) {
  const [updated] = await db
    .update(sessions)
    .set({ lifecycleRunId: runId, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.lifecycleRunId)))
    .returning({ id: sessions.id });

  return Boolean(updated);
}

export async function deleteSession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function createChat(data: NewChat) {
  const [chat] = await db.insert(chats).values(data).returning();
  if (!chat) {
    throw new Error("Failed to create chat");
  }
  return chat;
}

export async function getChatById(chatId: string) {
  return db.query.chats.findFirst({
    where: eq(chats.id, chatId),
  });
}

/**
 * Get all chats for a session, ordered by most recent activity first.
 * Activity is tracked on chats.updatedAt and updated when new messages arrive.
 */
export async function getChatsBySessionId(sessionId: string) {
  return db.query.chats.findMany({
    where: eq(chats.sessionId, sessionId),
    orderBy: [desc(chats.updatedAt), desc(chats.createdAt)],
  });
}

export type ChatSummary = typeof chats.$inferSelect & {
  hasUnread: boolean;
  isStreaming: boolean;
};

/**
 * Returns chats with per-user unread flags for sidebar rendering.
 */
export async function getChatSummariesBySessionId(
  sessionId: string,
  userId: string,
): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      id: chats.id,
      sessionId: chats.sessionId,
      title: chats.title,
      modelId: chats.modelId,
      lastAssistantMessageAt: chats.lastAssistantMessageAt,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      hasUnread: sql<boolean>`
        CASE
          WHEN ${chats.lastAssistantMessageAt} IS NULL THEN false
          WHEN ${chatReads.lastReadAt} IS NULL THEN true
          WHEN ${chats.lastAssistantMessageAt} > ${chatReads.lastReadAt} THEN true
          ELSE false
        END
      `,
    })
    .from(chats)
    .leftJoin(chatReads, and(eq(chatReads.chatId, chats.id), eq(chatReads.userId, userId)))
    .where(eq(chats.sessionId, sessionId))
    .orderBy(chats.createdAt);

  const streamingStatuses = await getEveChatStreamingStatuses(rows.map((row) => row.id));

  return rows.map((row) => ({
    ...row,
    isStreaming: streamingStatuses.get(row.id) ?? false,
  }));
}

export async function updateChat(
  chatId: string,
  data: Partial<Omit<NewChat, "id" | "sessionId" | "createdAt">>,
) {
  const [chat] = await db
    .update(chats)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(chats.id, chatId))
    .returning();
  return chat;
}

export async function touchChat(chatId: string, activityAt = new Date()) {
  const [chat] = await db
    .update(chats)
    .set({ updatedAt: activityAt })
    .where(eq(chats.id, chatId))
    .returning();
  return chat;
}

export async function updateChatAssistantActivity(chatId: string, activityAt: Date) {
  const [chat] = await db
    .update(chats)
    .set({
      lastAssistantMessageAt: activityAt,
      updatedAt: activityAt,
    })
    .where(eq(chats.id, chatId))
    .returning();
  return chat;
}

export async function deleteChat(chatId: string) {
  await db.delete(chats).where(eq(chats.id, chatId));
}

export async function markChatRead(data: Pick<NewChatRead, "userId" | "chatId">) {
  const now = new Date();
  const [chatRead] = await db
    .insert(chatReads)
    .values({
      userId: data.userId,
      chatId: data.chatId,
      lastReadAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [chatReads.userId, chatReads.chatId],
      set: {
        lastReadAt: now,
        updatedAt: now,
      },
    })
    .returning();

  return chatRead;
}
