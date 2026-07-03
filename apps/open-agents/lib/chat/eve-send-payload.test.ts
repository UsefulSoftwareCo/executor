import { describe, expect, test } from "bun:test";
import { toEveSendPayload, withOpenAgentsClientContext } from "./eve-send-payload";
import type { WebAgentUIMessage } from "@/app/types";

describe("toEveSendPayload", () => {
  test("moves snippets into Eve client context while sending text and files as message content", () => {
    const parts: WebAgentUIMessage["parts"] = [
      { type: "text", text: "Review this" },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,abc",
        filename: "screen.png",
      },
      {
        type: "data-snippet",
        id: "snippet-1",
        data: {
          content: "export const value = 1;",
          filename: "index.ts",
        },
      },
    ];

    const payload = toEveSendPayload({ parts });
    const prepared = withOpenAgentsClientContext(payload, {
      sessionId: "session-1",
      chatId: "chat-1",
      contextLimit: 200_000,
      actorUserId: "user-1",
    });

    expect(prepared.message).toEqual([
      { type: "text", text: "Review this" },
      {
        type: "file",
        data: "data:image/png;base64,abc",
        mediaType: "image/png",
        filename: "screen.png",
      },
      {
        type: "file",
        data: { type: "text", text: "export const value = 1;" },
        mediaType: "text/plain",
        filename: "index.ts",
      },
    ]);
    expect(prepared.clientContext).toEqual({
      openAgents: {
        sessionId: "session-1",
        chatId: "chat-1",
        contextLimit: 200_000,
        snippets: [
          {
            content: "export const value = 1;",
            filename: "index.ts",
          },
        ],
      },
    });
    expect(prepared.headers).toEqual({
      "x-open-agents-chat-id": "chat-1",
      "x-open-agents-session-id": "session-1",
      "x-open-agents-user-id": "user-1",
    });
  });
});
