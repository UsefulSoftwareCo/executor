import { describe, expect, test } from "bun:test";
import type { EveMessage } from "eve/client";
import { toWebAgentMessages } from "./eve-message-projection";

describe("toWebAgentMessages", () => {
  test("projects Eve text, authorization, and dynamic tool parts into the local renderer shape", () => {
    const messages: EveMessage[] = [
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Working on it",
            state: "streaming",
          },
          {
            type: "authorization",
            name: "github",
            displayName: "GitHub",
            description: "Connect GitHub to continue.",
            stepIndex: 0,
            turnId: "turn-1",
            state: "required",
            authorization: {
              url: "https://example.com/oauth",
              userCode: "ABCD",
            },
          },
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "tool-1",
            state: "approval-responded",
            input: { command: "bun test" },
            approval: { id: "approval-1" },
          },
        ],
      },
    ];

    expect(toWebAgentMessages(messages)).toEqual([
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Working on it",
            state: "streaming",
          },
          {
            type: "text",
            text: "Connect GitHub to continue.\n\n[Sign in with GitHub](https://example.com/oauth)\n\nCode: ABCD",
            state: "streaming",
          },
          {
            type: "tool-bash",
            toolCallId: "tool-1",
            state: "approval-responded",
            input: { command: "bun test" },
            approval: { id: "approval-1", approved: false },
          },
        ],
      },
    ]);
  });
});
