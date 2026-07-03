import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  type HandleMessageStreamEvent,
  isCurrentTurnBoundaryEvent,
  type SessionState,
} from "eve/client";
import { db } from "./client";
import {
  chats,
  eveChatEvents,
  eveChatSessionStates,
  type EveChatEvent,
  type EveChatSessionState,
  type NewEveChatEvent,
} from "./schema";

export type EveChatSessionSnapshot = {
  session: SessionState;
  events: HandleMessageStreamEvent[];
  isStreaming: boolean;
};

export type EveChatSessionStateRow = Pick<EveChatSessionState, "state">;
export type EveChatEventRow = Pick<EveChatEvent, "event">;
export type EveChatEventWithCreatedAtRow = Pick<EveChatEvent, "createdAt" | "event">;

export function createInitialEveChatSessionState(): SessionState {
  return { streamIndex: 0 };
}

export function isEveChatEventStreaming(
  event: HandleMessageStreamEvent | undefined,
): boolean {
  return event !== undefined && !isCurrentTurnBoundaryEvent(event);
}

export function toEveChatSessionSnapshot(input: {
  sessionState?: EveChatSessionStateRow;
  events: readonly EveChatEventRow[];
}): EveChatSessionSnapshot {
  const events = input.events.map((row) => row.event);

  return {
    session: input.sessionState?.state ?? createInitialEveChatSessionState(),
    events,
    isStreaming: isEveChatEventStreaming(events.at(-1)),
  };
}

export function buildEveChatEventRows(input: {
  chatId: string;
  firstStreamIndex: number;
  events: readonly HandleMessageStreamEvent[];
  createdAt?: Date;
}): NewEveChatEvent[] {
  return input.events.map((event, offset) => ({
    chatId: input.chatId,
    streamIndex: input.firstStreamIndex + offset,
    eventType: event.type,
    event,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }));
}

function hasAssistantMessage(events: readonly HandleMessageStreamEvent[]): boolean {
  return events.some((event) => event.type === "message.completed");
}

export async function getEveChatSessionState(chatId: string): Promise<SessionState> {
  const [sessionState] = await db
    .select({ state: eveChatSessionStates.state })
    .from(eveChatSessionStates)
    .where(eq(eveChatSessionStates.chatId, chatId))
    .limit(1);

  return sessionState?.state ?? createInitialEveChatSessionState();
}

export async function upsertEveChatSessionState(
  chatId: string,
  state: SessionState,
): Promise<void> {
  const now = new Date();

  await db
    .insert(eveChatSessionStates)
    .values({
      chatId,
      state,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: eveChatSessionStates.chatId,
      set: {
        state,
        updatedAt: now,
      },
    });
}

export async function getEveChatEvents(
  chatId: string,
  options?: { startIndex?: number },
): Promise<HandleMessageStreamEvent[]> {
  const startIndex = options?.startIndex ?? 0;
  const where =
    startIndex > 0
      ? and(eq(eveChatEvents.chatId, chatId), gte(eveChatEvents.streamIndex, startIndex))
      : eq(eveChatEvents.chatId, chatId);

  const events = await db
    .select({ event: eveChatEvents.event })
    .from(eveChatEvents)
    .where(where)
    .orderBy(eveChatEvents.streamIndex);

  return events.map((row) => row.event);
}

export async function getLatestEveChatEvent(
  chatId: string,
): Promise<HandleMessageStreamEvent | undefined> {
  const [latest] = await db
    .select({ event: eveChatEvents.event })
    .from(eveChatEvents)
    .where(eq(eveChatEvents.chatId, chatId))
    .orderBy(desc(eveChatEvents.streamIndex))
    .limit(1);

  return latest?.event;
}

export async function getEveChatStreamingStatuses(
  chatIds: readonly string[],
): Promise<Map<string, boolean>> {
  const statuses = new Map(chatIds.map((chatId) => [chatId, false]));
  if (chatIds.length === 0) {
    return statuses;
  }

  const events = await db
    .select({
      chatId: eveChatEvents.chatId,
      event: eveChatEvents.event,
    })
    .from(eveChatEvents)
    .where(inArray(eveChatEvents.chatId, [...new Set(chatIds)]))
    .orderBy(eveChatEvents.chatId, desc(eveChatEvents.streamIndex));

  const seenChatIds = new Set<string>();
  for (const event of events) {
    if (seenChatIds.has(event.chatId)) {
      continue;
    }

    seenChatIds.add(event.chatId);
    statuses.set(event.chatId, isEveChatEventStreaming(event.event));
  }

  return statuses;
}

export async function getIsEveChatStreaming(chatId: string): Promise<boolean> {
  return isEveChatEventStreaming(await getLatestEveChatEvent(chatId));
}

export async function getEveChatSessionSnapshot(
  chatId: string,
): Promise<EveChatSessionSnapshot> {
  return db.transaction(async (tx) => {
    const [sessionState] = await tx
      .select({ state: eveChatSessionStates.state })
      .from(eveChatSessionStates)
      .where(eq(eveChatSessionStates.chatId, chatId))
      .limit(1);

    const events = await tx
      .select({ event: eveChatEvents.event })
      .from(eveChatEvents)
      .where(eq(eveChatEvents.chatId, chatId))
      .orderBy(eveChatEvents.streamIndex);

    return toEveChatSessionSnapshot({ sessionState, events });
  });
}

export async function getEveChatEventRows(
  chatId: string,
): Promise<EveChatEventWithCreatedAtRow[]> {
  return db
    .select({
      event: eveChatEvents.event,
      createdAt: eveChatEvents.createdAt,
    })
    .from(eveChatEvents)
    .where(eq(eveChatEvents.chatId, chatId))
    .orderBy(eveChatEvents.streamIndex);
}

export async function appendEveChatEvents(input: {
  chatId: string;
  firstStreamIndex: number;
  events: readonly HandleMessageStreamEvent[];
}): Promise<void> {
  if (input.events.length === 0) {
    return;
  }

  await db.insert(eveChatEvents).values(buildEveChatEventRows(input));
}

type PersistEveChatSessionPatchInput =
  | {
      chatId: string;
      events: readonly HandleMessageStreamEvent[];
      firstStreamIndex: number;
      session?: SessionState;
    }
  | {
      chatId: string;
      events?: undefined;
      firstStreamIndex?: undefined;
      session: SessionState;
    };

export async function persistEveChatSessionPatch(
  input: PersistEveChatSessionPatchInput,
): Promise<void> {
  const now = new Date();
  const events = input.events ?? [];
  const firstStreamIndex = input.firstStreamIndex ?? 0;
  const session = input.session;

  await db.transaction(async (tx) => {
    if (events.length > 0) {
      await tx
        .insert(eveChatEvents)
        .values(
          buildEveChatEventRows({
            chatId: input.chatId,
            firstStreamIndex,
            events,
            createdAt: now,
          }),
        )
        .onConflictDoNothing();

      await tx
        .update(chats)
        .set({
          updatedAt: now,
          ...(hasAssistantMessage(events) ? { lastAssistantMessageAt: now } : {}),
        })
        .where(eq(chats.id, input.chatId));
    }

    if (session) {
      await tx
        .insert(eveChatSessionStates)
        .values({
          chatId: input.chatId,
          state: session,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: eveChatSessionStates.chatId,
          set: {
            state: session,
            updatedAt: now,
          },
        });
    }
  });
}

export async function persistEveChatSessionProgress(input: {
  chatId: string;
  session: SessionState;
  firstStreamIndex: number;
  events: readonly HandleMessageStreamEvent[];
}): Promise<void> {
  await persistEveChatSessionPatch({
    chatId: input.chatId,
    session: input.session,
    firstStreamIndex: input.firstStreamIndex,
    events: input.events,
  });
}

export async function resetEveChatSessionPersistence(chatId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(eveChatEvents).where(eq(eveChatEvents.chatId, chatId));
    await tx.delete(eveChatSessionStates).where(eq(eveChatSessionStates.chatId, chatId));
  });
}
