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
const updateSessionMock = mock(async () => undefined);

mock.module("server-only", () => ({}));
mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireSessionAccess: requireSessionAccessMock,
}));
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: { id: "viewer-user", username: "viewer", name: "Viewer" },
  }),
}));
mock.module("@/lib/github/pr-content", () => ({
  generatePullRequestContentFromSandbox: async () => ({
    success: true,
    title: "Shared PR",
    body: "Opened from a shared session",
  }),
}));
mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => ({
    id: "session-1",
    userId: "creator-user",
    branch: "feature/shared",
    cloneUrl: "https://github.com/GoAugment/example",
    repoOwner: "GoAugment",
    repoName: "example",
    prNumber: 123,
    prStatus: "open",
    sandboxState: {
      type: "vercel",
      sandboxName: "sandbox-1",
      expiresAt: Date.now() + 3_600_000,
    },
  }),
  updateSession: updateSessionMock,
}));

const prModulePromise = import("./pr");

describe("GitHub PR actions", () => {
  beforeEach(() => {
    requireSessionAccessMock.mockClear();
    updateSessionMock.mockClear();
  });

  test("openPullRequest allows a shared non-creator when authz grants write access", async () => {
    const { openPullRequest } = await prModulePromise;

    const result = await openPullRequest({
      sessionId: "session-1",
      repoUrl: "https://github.com/GoAugment/example",
      baseBranch: "main",
      branchName: "feature/shared",
      headOwner: "viewer-fork",
      title: "Shared PR",
      body: "Opened from a shared session",
    });

    expect(result.success).toBe(true);
    expect(result.requiresManualCreation).toBe(true);
    expect(result.prUrl).toContain("https://github.com/GoAugment/example/compare/main...");
    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "write",
    );
  });
});
