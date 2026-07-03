import { getVercelOidcToken } from "@vercel/oidc";
import { and, eq, sql } from "drizzle-orm";
import {
  Client,
  defaultMessageReducer,
  type HandleMessageStreamEvent,
  type SendTurnPayload,
  type SessionState,
} from "eve/client";
import type { WebAgentUIMessage } from "@/app/types";
import { toWebAgentMessages } from "@/lib/chat/eve-message-projection";
import { toEveSendPayload, withOpenAgentsClientContext } from "@/lib/chat/eve-send-payload";
import { db } from "@/lib/db/client";
import { chats, eveChatEvents, sessions } from "@/lib/db/schema";
import { getEveChatSessionState, persistEveChatSessionProgress } from "@/lib/db/sessions";

export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
export const EVE_MESSAGE_STREAM_VERSION = "16";

export type EveChatTurnPayload = Pick<
  SendTurnPayload,
  "clientContext" | "headers" | "inputResponses" | "message" | "outputSchema"
>;

export type EveChatTurnStream = {
  stream: ReadableStream<Uint8Array>;
  sessionId: string;
};

export type EveChatMessageTurnResult = {
  events: HandleMessageStreamEvent[];
  messages: WebAgentUIMessage[];
  sessionId: string;
};

const textEncoder = new TextEncoder();

export async function countEveUserMessagesByUserId(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(eveChatEvents)
    .innerJoin(chats, eq(chats.id, eveChatEvents.chatId))
    .innerJoin(sessions, eq(sessions.id, chats.sessionId))
    .where(and(eq(sessions.userId, userId), eq(eveChatEvents.eventType, "message.received")));

  return result?.count ?? 0;
}

export async function createEveChatTurnStream(input: {
  chatId: string;
  payload: EveChatTurnPayload;
  requestUrl: string;
  signal?: AbortSignal;
}): Promise<EveChatTurnStream> {
  const turn = await createEveChatTurnEvents(input);

  return {
    sessionId: turn.sessionId,
    stream: createEveEventReadableStream(turn.events),
  };
}

export async function runEveChatMessageTurn(input: {
  chatId: string;
  clientContext?: Record<string, unknown>;
  message: WebAgentUIMessage;
  requestUrl: string;
  sessionId: string;
  signal?: AbortSignal;
  toolProfile?: readonly string[];
}): Promise<EveChatMessageTurnResult> {
  const payload = withOpenAgentsClientContext(toEveSendPayload({ parts: input.message.parts }), {
    chatId: input.chatId,
    contextLimit: null,
    metadata: input.clientContext,
    sessionId: input.sessionId,
    ...(input.toolProfile ? { toolProfile: input.toolProfile } : {}),
  });
  const turn = await createEveChatTurnEvents({
    chatId: input.chatId,
    payload,
    requestUrl: input.requestUrl,
    signal: input.signal,
  });
  const reducer = defaultMessageReducer();
  const events: HandleMessageStreamEvent[] = [];
  let data = reducer.initial();

  for await (const event of turn.events) {
    events.push(event);
    data = reducer.reduce(data, event);
  }

  return {
    events,
    messages: toWebAgentMessages(data.messages),
    sessionId: turn.sessionId,
  };
}

async function createEveChatTurnEvents(input: {
  chatId: string;
  payload: EveChatTurnPayload;
  requestUrl: string;
  signal?: AbortSignal;
}): Promise<{
  events: AsyncIterable<HandleMessageStreamEvent>;
  sessionId: string;
}> {
  const initialSession = await getEveChatSessionState(input.chatId);
  const session = createEveClient(input.requestUrl).session(initialSession);
  const response = await session.send({
    ...input.payload,
    signal: input.signal,
  });

  const firstStreamIndex =
    initialSession.sessionId === response.sessionId ? initialSession.streamIndex : 0;

  return {
    sessionId: response.sessionId,
    events: createPersistedEveEvents({
      chatId: input.chatId,
      continuationToken: response.continuationToken ?? initialSession.continuationToken,
      events: response,
      firstStreamIndex,
      sessionId: response.sessionId,
    }),
  };
}

export function createEveChatStreamResponse(turn: EveChatTurnStream): Response {
  return new Response(turn.stream, {
    headers: {
      "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
      "x-eve-session-id": turn.sessionId,
      "x-eve-stream-format": EVE_MESSAGE_STREAM_FORMAT,
      "x-eve-stream-version": EVE_MESSAGE_STREAM_VERSION,
    },
  });
}

function createEveClient(requestUrl: string) {
  return new Client({
    auth: process.env.VERCEL ? { vercelOidc: { token: () => getVercelOidcToken() } } : undefined,
    host: getRequestOrigin(requestUrl),
    preserveCompletedSessions: true,
    redirect: "manual",
  });
}

function getRequestOrigin(requestUrl: string): string {
  const absoluteUrl =
    requestUrl.startsWith("http://") || requestUrl.startsWith("https://")
      ? requestUrl
      : `https://${requestUrl}`;
  return new URL(absoluteUrl).origin;
}

async function* createPersistedEveEvents(input: {
  chatId: string;
  continuationToken?: string;
  events: AsyncIterable<HandleMessageStreamEvent>;
  firstStreamIndex: number;
  sessionId: string;
}): AsyncIterable<HandleMessageStreamEvent> {
  let streamIndex = input.firstStreamIndex;

  for await (const event of input.events) {
    const session = buildSessionState({
      continuationToken: input.continuationToken,
      sessionId: input.sessionId,
      streamIndex: streamIndex + 1,
    });

    await persistEveChatSessionProgress({
      chatId: input.chatId,
      events: [event],
      firstStreamIndex: streamIndex,
      session,
    });

    streamIndex += 1;
    yield event;
  }
}

function createEveEventReadableStream(
  events: AsyncIterable<HandleMessageStreamEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: ReadableStream adapter reports async iterator failures through controller.error
      try {
        for await (const event of events) {
          controller.enqueue(textEncoder.encode(`${JSON.stringify(event)}\n`));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function buildSessionState(input: {
  continuationToken?: string;
  sessionId: string;
  streamIndex: number;
}): SessionState {
  return input.continuationToken
    ? {
        continuationToken: input.continuationToken,
        sessionId: input.sessionId,
        streamIndex: input.streamIndex,
      }
    : {
        sessionId: input.sessionId,
        streamIndex: input.streamIndex,
      };
}
