import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockAuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

const requireSessionAccessMock = mock(async () => ({ scopeKind: "group", scopeId: "group-1" }));
const execMock = mock(async (command: string) => {
  if (command.startsWith("git symbolic-ref --short HEAD")) {
    return { success: true, stdout: "feature/shared\n", stderr: "" };
  }
  if (command.startsWith("git status --porcelain")) {
    return { success: true, stdout: " M app.ts\n?? new.ts\n", stderr: "" };
  }
  if (command.startsWith("git rev-parse --abbrev-ref")) {
    return { success: true, stdout: "origin/feature/shared\n", stderr: "" };
  }
  if (command.startsWith("git rev-list")) {
    return { success: true, stdout: "", stderr: "" };
  }
  return { success: true, stdout: "", stderr: "" };
});
const connectSandboxMock = mock(async () => ({
  workingDirectory: "/workspace",
  exec: execMock,
}));

mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireChatAccess: async () => ({ scopeKind: "group", scopeId: "group-1" }),
  requireSessionAccess: requireSessionAccessMock,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: connectSandboxMock,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({ user: { id: "viewer-user" } }),
}));

mock.module("@/lib/db/sessions", () => ({
  createChat: async () => undefined,
  getChatById: async () => null,
  getChatSummariesBySessionId: async () => [],
  updateSession: async () => undefined,
  getSessionById: async () => ({
    id: "session-1",
    userId: "creator-user",
    sandboxState: {
      type: "vercel",
      sandboxName: "sandbox-1",
      expiresAt: Date.now() + 3_600_000,
    },
  }),
}));

const modulePromise = import("./status");

describe("git status query session authorization", () => {
  beforeEach(() => {
    requireSessionAccessMock.mockClear();
    connectSandboxMock.mockClear();
    execMock.mockClear();
  });

  test("allows a shared non-creator through read authz", async () => {
    const { getGitStatus } = await modulePromise;

    const result = await getGitStatus({ sessionId: "session-1" });

    expect(result).toEqual({
      branch: "feature/shared",
      isDetachedHead: false,
      hasUncommittedChanges: true,
      hasUnpushedCommits: false,
      stagedCount: 1,
      unstagedCount: 0,
      untrackedCount: 1,
      uncommittedFiles: 2,
    });
    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "read",
    );
    expect(connectSandboxMock).toHaveBeenCalledTimes(1);
  });
});
