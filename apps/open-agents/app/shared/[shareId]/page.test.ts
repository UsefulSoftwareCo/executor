import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HandleMessageStreamEvent } from "eve/client";

const NOT_FOUND_ERROR = new Error("not-found");
type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

let shareRecord: { id: string; chatId: string } | null = {
  id: "share-1",
  chatId: "chat-1",
};
let chatRecord: {
  id: string;
  sessionId: string;
  title: string;
  modelId: string | null;
} | null = {
  id: "chat-1",
  sessionId: "session-1",
  title: "Debug flaky tests",
  modelId: "anthropic/claude-opus-4.6",
};
let sessionRecord: {
  id: string;
  userId: string;
  title: string;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  cloneUrl: string | null;
  prNumber: number | null;
  prStatus: string | null;
} | null = {
  id: "session-1",
  userId: "user-1",
  title: "Session Title",
  repoOwner: "acme",
  repoName: "repo",
  branch: "main",
  cloneUrl: "https://github.com/acme/repo.git",
  prNumber: null,
  prStatus: null,
};
let eventRows: Array<{ event: HandleMessageStreamEvent; createdAt: Date }> = [];
let viewerSession: { user: { id: string } } | null = null;
let userModelVariants: Array<{
  id: string;
  name: string;
  baseModelId: string;
  providerOptions: Record<string, unknown>;
}> = [];
let isEveStreaming = false;

function eventRow(event: HandleMessageStreamEvent, createdAt = "2025-01-01T00:00:00Z") {
  return {
    event,
    createdAt: new Date(createdAt),
  };
}

function userMessageEvent(message = "Hello", turnId = "turn-1"): HandleMessageStreamEvent {
  return {
    type: "message.received",
    data: {
      message,
      sequence: 1,
      turnId,
    },
  };
}

function assistantMessageEvent(message = "Done", turnId = "turn-1"): HandleMessageStreamEvent {
  return {
    type: "message.completed",
    data: {
      finishReason: "stop",
      message,
      sequence: 2,
      stepIndex: 0,
      turnId,
    },
  };
}

function toolRequestEvent(
  actions: Array<{
    callId: string;
    toolName: string;
    input: JsonObject;
  }>,
): HandleMessageStreamEvent {
  return {
    type: "actions.requested",
    data: {
      actions: actions.map((action) => ({
        kind: "tool-call" as const,
        callId: action.callId,
        toolName: action.toolName,
        input: action.input,
      })),
      sequence: 2,
      stepIndex: 0,
      turnId: "turn-1",
    },
  };
}

function toolResultEvent(input: {
  callId: string;
  toolName: string;
  output: JsonValue;
  sequence: number;
}): HandleMessageStreamEvent {
  return {
    type: "action.result",
    data: {
      result: {
        kind: "tool-result",
        callId: input.callId,
        toolName: input.toolName,
        output: input.output,
      },
      sequence: input.sequence,
      stepIndex: 0,
      status: "completed",
      turnId: "turn-1",
    },
  };
}

function defaultEventRows() {
  return [eventRow(userMessageEvent())];
}

mock.module("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND_ERROR;
  },
}));

mock.module("@/lib/db/sessions-cache", () => ({
  getShareByIdCached: async () => shareRecord,
  getSessionByIdCached: async () => sessionRecord,
}));

mock.module("@/lib/db/client", () => ({
  db: {
    query: {
      users: {
        findFirst: async () => ({
          username: "testuser",
          name: "Test User",
          avatarUrl: "https://example.com/avatar.png",
        }),
      },
    },
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getChatById: async () => chatRecord,
  getEveChatEventRows: async () => eventRows,
  getIsEveChatStreaming: async () => isEveStreaming,
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({
    defaultModelId: "anthropic/claude-opus-4.6",
    defaultSubagentModelId: null,
    defaultSandboxType: "vercel",
    defaultDiffMode: "unified",
    autoCommitPush: false,
    modelVariants: userModelVariants,
  }),
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => viewerSession,
}));

mock.module("./shared-chat-content", () => ({
  SharedChatContent: (_props: unknown) => null,
}));

const pageModulePromise = import("./page");

describe("/shared/[shareId] page", () => {
  beforeEach(() => {
    shareRecord = { id: "share-1", chatId: "chat-1" };
    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      title: "Debug flaky tests",
      modelId: "anthropic/claude-opus-4.6",
    };
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Session Title",
      repoOwner: "acme",
      repoName: "repo",
      branch: "main",
      cloneUrl: "https://github.com/acme/repo.git",
      prNumber: null,
      prStatus: null,
    };
    eventRows = defaultEventRows();
    viewerSession = null;
    userModelVariants = [];
    isEveStreaming = false;
  });

  test("generateMetadata uses shared chat title", async () => {
    const { generateMetadata } = await pageModulePromise;

    const metadata = await generateMetadata({
      params: Promise.resolve({ shareId: "share-1" }),
    });

    expect(metadata.title).toBe("Debug flaky tests");
  });

  test("renders exactly one shared chat from share id mapping", async () => {
    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        chats: Array<{ chat: { id: string }; messagesWithTiming: unknown[] }>;
      };
    };

    expect(element.props.chats).toHaveLength(1);
    expect(element.props.chats[0]?.chat.id).toBe("chat-1");
    expect(element.props.chats[0]?.messagesWithTiming).toHaveLength(1);
  });

  test("passes ownerSessionHref when viewer owns the session", async () => {
    viewerSession = { user: { id: "user-1" } };
    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        ownerSessionHref: string | null;
      };
    };

    expect(element.props.ownerSessionHref).toBe("/sessions/session-1/chats/chat-1");
  });

  test("passes custom variant name to shared chat content", async () => {
    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      title: "Debug flaky tests",
      modelId: "variant:abc123",
    };
    userModelVariants = [
      {
        id: "variant:abc123",
        name: "Gateway Usage Variant",
        baseModelId: "openai/gpt-5.4",
        providerOptions: {
          reasoningEffort: "high",
        },
      },
    ];

    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        modelName: string | null;
      };
    };

    expect(element.props.modelName).toBe("Gateway Usage Variant");
  });

  test("redacts top-level .env tool content on shared pages", async () => {
    eventRows = [
      eventRow(
        toolRequestEvent([
          {
            callId: "read-file-call",
            toolName: "read_file",
            input: { filePath: ".env.local" },
          },
          {
            callId: "write-env-example-call",
            toolName: "write_file",
            input: {
              filePath: "apps/web/.env.example",
              content: "FOO=bar\nBAR=baz",
            },
          },
          {
            callId: "write-env-call",
            toolName: "write_file",
            input: {
              filePath: ".env",
              content: "NEW_SECRET=two",
            },
          },
          {
            callId: "write-readme-call",
            toolName: "write_file",
            input: {
              filePath: "README.md",
              content: "visible content",
            },
          },
        ]),
      ),
      eventRow(
        toolResultEvent({
          callId: "read-file-call",
          toolName: "read_file",
          output: {
            success: true,
            content: "1: SECRET=shh\n2: TOKEN=abc",
            totalLines: 2,
            startLine: 1,
            endLine: 2,
          },
          sequence: 3,
        }),
      ),
      eventRow(
        toolResultEvent({
          callId: "write-env-example-call",
          toolName: "write_file",
          output: { success: true },
          sequence: 4,
        }),
      ),
      eventRow(
        toolResultEvent({
          callId: "write-env-call",
          toolName: "write_file",
          output: { success: true },
          sequence: 5,
        }),
      ),
      eventRow(
        toolResultEvent({
          callId: "write-readme-call",
          toolName: "write_file",
          output: { success: true },
          sequence: 6,
        }),
      ),
    ];

    const { default: SharedPage } = await pageModulePromise;
    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        chats: Array<{
          messagesWithTiming: Array<{
            message: { parts: Array<Record<string, unknown>> };
          }>;
        }>;
      };
    };

    const parts = element.props.chats[0]?.messagesWithTiming[0]?.message.parts ?? [];
    const readPart = parts.find((part) => part.type === "tool-read_file");
    const writeParts = parts.filter((part) => part.type === "tool-write_file");

    expect(readPart?.output).toEqual({
      success: true,
      content: "1: [redacted from shared page]\n2: [redacted from shared page]",
      totalLines: 2,
      startLine: 1,
      endLine: 2,
    });
    expect(writeParts[0]?.input).toEqual({
      filePath: "apps/web/.env.example",
      content: "[content redacted from shared page]\n[content redacted from shared page]",
    });
    expect(writeParts[1]?.input).toEqual({
      filePath: ".env",
      content: "[content redacted from shared page]",
    });
    expect(writeParts[2]?.input).toEqual({
      filePath: "README.md",
      content: "visible content",
    });
  });

  test("redacts nested .env tool content inside shared agent output", async () => {
    eventRows = [
      eventRow(
        toolRequestEvent([
          {
            callId: "agent-call",
            toolName: "agent",
            input: {
              message: "Inspect secrets",
            },
          },
        ]),
      ),
      eventRow(
        toolResultEvent({
          callId: "agent-call",
          toolName: "agent",
          output: {
            final: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-read-file",
                    toolName: "read_file",
                    input: { filePath: ".env" },
                  },
                  {
                    type: "tool-call",
                    toolCallId: "call-write-file",
                    toolName: "write_file",
                    input: {
                      filePath: ".env.local",
                      content: "SECRET=new",
                    },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-read-file",
                    output: {
                      type: "json",
                      value: {
                        success: true,
                        content: "1: SECRET=old",
                        totalLines: 1,
                        startLine: 1,
                        endLine: 1,
                      },
                    },
                  },
                ],
              },
            ],
          },
          sequence: 3,
        }),
      ),
    ];

    const { default: SharedPage } = await pageModulePromise;
    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        chats: Array<{
          messagesWithTiming: Array<{
            message: { parts: Array<Record<string, unknown>> };
          }>;
        }>;
      };
    };

    const agentPart = element.props.chats[0]?.messagesWithTiming[0]?.message.parts.find(
      (part) => part.type === "dynamic-tool" && part.toolName === "agent",
    ) as Record<string, unknown> | undefined;
    if (!agentPart) {
      throw new Error("Expected agent tool part");
    }
    const agentOutput = agentPart.output as {
      final: Array<Record<string, unknown>>;
    };
    const nestedAssistant = agentOutput.final[0]?.content as Array<Record<string, unknown>>;
    const nestedTool = agentOutput.final[1]?.content as Array<Record<string, unknown>>;

    expect(nestedAssistant[1]?.input).toEqual({
      filePath: ".env.local",
      content: "[content redacted from shared page]",
    });
    expect(nestedTool[0]?.output).toEqual({
      type: "json",
      value: {
        success: true,
        content: "1: [redacted from shared page]",
        totalLines: 1,
        startLine: 1,
        endLine: 1,
      },
    });
  });

  test("throws notFound when share mapping does not exist", async () => {
    shareRecord = null;
    const { default: SharedPage } = await pageModulePromise;

    expect(async () => {
      await SharedPage({ params: Promise.resolve({ shareId: "missing" }) });
    }).toThrow("not-found");
  });

  test("passes isStreaming=false and lastUserMessageSentAt when chat is idle", async () => {
    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: {
        isStreaming: boolean;
        lastUserMessageSentAt: string | null;
        shareId: string;
      };
    };

    expect(element.props.isStreaming).toBe(false);
    expect(element.props.lastUserMessageSentAt).toBe("2025-01-01T00:00:00.000Z");
    expect(element.props.shareId).toBe("share-1");
  });

  test("passes isStreaming=true when Eve chat is streaming", async () => {
    isEveStreaming = true;
    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: { isStreaming: boolean; lastUserMessageSentAt: string | null };
    };

    expect(element.props.isStreaming).toBe(true);
    expect(element.props.lastUserMessageSentAt).toBe("2025-01-01T00:00:00.000Z");
  });

  test("lastUserMessageSentAt is null when there are no user messages", async () => {
    eventRows = [eventRow(assistantMessageEvent(), "2025-01-01T00:01:00Z")];
    const { default: SharedPage } = await pageModulePromise;

    const element = (await SharedPage({
      params: Promise.resolve({ shareId: "share-1" }),
    })) as {
      props: { lastUserMessageSentAt: string | null };
    };

    expect(element.props.lastUserMessageSentAt).toBeNull();
  });
});
