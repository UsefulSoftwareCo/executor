import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Chat, Session } from "@/lib/db/schema";

class MockAuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

type SessionRecord = Session;
type ChatRecord = Chat;

function buildSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "session-1",
    userId: "creator-user",
    scopeKind: "user",
    scopeId: "creator-user",
    title: "Session",
    status: "running",
    repoOwner: null,
    repoName: null,
    branch: null,
    cloneUrl: null,
    vercelProjectId: null,
    vercelProjectName: null,
    vercelTeamId: null,
    vercelTeamSlug: null,
    workspaceRepos: [],
    isNewBranch: false,
    autoCommitPushOverride: null,
    autoCreatePrOverride: null,
    globalSkillRefs: [],
    agentName: null,
    sandboxState: null,
    lifecycleState: null,
    lifecycleVersion: 0,
    lastActivityAt: null,
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
    linesAdded: 0,
    linesRemoved: 0,
    prNumber: null,
    prStatus: null,
    cachedDiff: null,
    cachedDiffUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: "chat-1",
    sessionId: "session-1",
    title: "Shared chat",
    scopeKind: "group",
    scopeId: "group-1",
    modelId: "model-1",
    lastAssistantMessageAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

type RequireChatAccessCall = {
  actor: { kind: "user"; userId: string };
  chatId: string;
  verb: "read";
};

type RequireSessionAccessCall = {
  actor: { kind: "user"; userId: string };
  sessionId: string;
  verb: "read";
};

let sessionRecord: SessionRecord | null = {
  ...buildSession(),
};
let requireChatAccessError: MockAuthzError | null = null;
let requireSessionAccessError: MockAuthzError | null = null;
const requireChatAccessCalls: RequireChatAccessCall[] = [];
const requireSessionAccessCalls: RequireSessionAccessCall[] = [];

mock.module("@/lib/db/sessions-cache", () => ({
  getSessionByIdCached: async () => sessionRecord,
}));

mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireChatAccess: async (
    actor: RequireChatAccessCall["actor"],
    chatId: string,
    verb: "read",
  ) => {
    requireChatAccessCalls.push({ actor, chatId, verb });
    if (requireChatAccessError) {
      throw requireChatAccessError;
    }
    return { scopeKind: "group", scopeId: "group-1" };
  },
  requireSessionAccess: async (
    actor: RequireSessionAccessCall["actor"],
    sessionId: string,
    verb: "read",
  ) => {
    requireSessionAccessCalls.push({ actor, sessionId, verb });
    if (requireSessionAccessError) {
      throw requireSessionAccessError;
    }
    return { scopeKind: "user", scopeId: actor.userId };
  },
}));

const modulePromise = import("./session-route-context");

describe("session route context", () => {
  beforeEach(() => {
    sessionRecord = buildSession();
    requireChatAccessError = null;
    requireSessionAccessError = null;
    requireChatAccessCalls.length = 0;
    requireSessionAccessCalls.length = 0;
  });

  test("readable chat context delegates chat authorization to requireChatAccess", async () => {
    const { getReadableChatPageContext } = await modulePromise;
    const chat = buildChat();

    const result = await getReadableChatPageContext({
      userId: "viewer-user",
      sessionId: "session-1",
      chatId: "chat-1",
      loadChat: async () => chat,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionRecord.id).toBe("session-1");
      expect(result.chat).toEqual(chat);
    }
    expect(requireChatAccessCalls).toEqual([
      {
        actor: { kind: "user", userId: "viewer-user" },
        chatId: "chat-1",
        verb: "read",
      },
    ]);
  });

  test("readable chat context rejects inaccessible chat overrides", async () => {
    const { getReadableChatPageContext } = await modulePromise;
    requireChatAccessError = new MockAuthzError("Chat access denied", 403);

    const result = await getReadableChatPageContext({
      userId: "viewer-user",
      sessionId: "session-1",
      chatId: "chat-1",
      loadChat: async () =>
        buildChat({
          scopeKind: "user",
          scopeId: "creator-user",
        }),
    });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  test("readable chat context treats cross-session chat ids as missing before loading chat data", async () => {
    const { getReadableChatPageContext } = await modulePromise;

    const result = await getReadableChatPageContext({
      userId: "viewer-user",
      sessionId: "session-1",
      chatId: "chat-1",
      loadChat: async () => buildChat({ sessionId: "session-2" }),
    });

    expect(result).toEqual({ ok: false, reason: "chat-not-found" });
    expect(requireChatAccessCalls).toHaveLength(0);
  });

  test("session shell can render a chat override when session scope is denied", async () => {
    const { canRenderSessionShell } = await modulePromise;
    requireSessionAccessError = new MockAuthzError("Session access denied", 403);

    const result = await canRenderSessionShell({
      userId: "viewer-user",
      sessionId: "session-1",
      accessibleChats: [
        {
          id: "chat-1",
          sessionId: "session-1",
          title: "Shared chat",
          scopeKind: "group",
          scopeId: "group-1",
          modelId: "model-1",
          lastAssistantMessageAt: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          hasUnread: false,
          isStreaming: false,
        },
      ],
    });

    expect(result).toBe(true);
    expect(requireSessionAccessCalls).toEqual([
      {
        actor: { kind: "user", userId: "viewer-user" },
        sessionId: "session-1",
        verb: "read",
      },
    ]);
  });

  test("session shell rejects denied session scope with no readable chats", async () => {
    const { canRenderSessionShell } = await modulePromise;
    requireSessionAccessError = new MockAuthzError("Session access denied", 403);

    await expect(
      canRenderSessionShell({
        userId: "viewer-user",
        sessionId: "session-1",
        accessibleChats: [],
      }),
    ).resolves.toBe(false);
  });
});
