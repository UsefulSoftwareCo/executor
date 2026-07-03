import { describe, expect, mock, test } from "bun:test";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";

mock.module("./client", () => ({
  db: {},
}));

const eveChatSessionsModulePromise = import("./eve-chat-sessions");

const messageReceivedEvent = {
  type: "message.received",
  data: {
    message: "hello",
    sequence: 1,
    turnId: "turn-1",
  },
} satisfies HandleMessageStreamEvent;

const sessionWaitingEvent = {
  type: "session.waiting",
  data: {
    wait: "next-user-message",
  },
} satisfies HandleMessageStreamEvent;

describe("createInitialEveChatSessionState", () => {
  test("returns the empty Eve cursor", async () => {
    const { createInitialEveChatSessionState } = await eveChatSessionsModulePromise;

    expect(createInitialEveChatSessionState()).toEqual({ streamIndex: 0 });
  });
});

describe("buildEveChatEventRows", () => {
  test("assigns stable stream indexes and event types", async () => {
    const { buildEveChatEventRows } = await eveChatSessionsModulePromise;
    const createdAt = new Date("2026-01-01T00:00:00.000Z");

    expect(
      buildEveChatEventRows({
        chatId: "chat-1",
        firstStreamIndex: 3,
        events: [messageReceivedEvent, sessionWaitingEvent],
        createdAt,
      }),
    ).toEqual([
      {
        chatId: "chat-1",
        streamIndex: 3,
        eventType: "message.received",
        event: messageReceivedEvent,
        createdAt,
      },
      {
        chatId: "chat-1",
        streamIndex: 4,
        eventType: "session.waiting",
        event: sessionWaitingEvent,
        createdAt,
      },
    ]);
  });
});

describe("toEveChatSessionSnapshot", () => {
  test("uses the initial session state when none has been persisted", async () => {
    const { toEveChatSessionSnapshot } = await eveChatSessionsModulePromise;

    expect(
      toEveChatSessionSnapshot({
        events: [{ event: messageReceivedEvent }],
      }),
    ).toEqual({
      session: { streamIndex: 0 },
      events: [messageReceivedEvent],
      isStreaming: true,
    });
  });

  test("preserves persisted session state and detects turn boundaries", async () => {
    const { toEveChatSessionSnapshot } = await eveChatSessionsModulePromise;
    const state = {
      sessionId: "eve-session-1",
      continuationToken: "continuation-1",
      streamIndex: 5,
    } satisfies SessionState;

    expect(
      toEveChatSessionSnapshot({
        sessionState: { state },
        events: [{ event: messageReceivedEvent }, { event: sessionWaitingEvent }],
      }),
    ).toEqual({
      session: state,
      events: [messageReceivedEvent, sessionWaitingEvent],
      isStreaming: false,
    });
  });
});
