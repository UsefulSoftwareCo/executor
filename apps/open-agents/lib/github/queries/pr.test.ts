import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockAuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

type SessionRecord = {
  id: string;
  userId: string;
  sandboxState: null;
  branch: string | null;
  prNumber: number | null;
  prStatus: "open" | "merged" | "closed" | null;
  repoOwner: string | null;
  repoName: string | null;
  cloneUrl: string | null;
};

const requireSessionAccessMock = mock(async () => ({ scopeKind: "group", scopeId: "group-1" }));
let sessionRecord: SessionRecord = {
  id: "session-1",
  userId: "creator-user",
  sandboxState: null,
  branch: "feature/shared",
  prNumber: 12,
  prStatus: "open",
  repoOwner: null,
  repoName: null,
  cloneUrl: null,
};

mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireChatAccess: async () => ({ scopeKind: "group", scopeId: "group-1" }),
  requireSessionAccess: requireSessionAccessMock,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async () => {
    throw new Error("sandbox should not be used in this test");
  },
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({ user: { id: "viewer-user" } }),
}));

mock.module("@/lib/db/sessions", () => ({
  createChat: async () => undefined,
  getChatById: async () => null,
  getChatSummariesBySessionId: async () => [],
  getSessionById: async () => sessionRecord,
  updateSession: async () => undefined,
}));

mock.module("@/lib/github/token", () => ({
  getUserGitHubToken: async () => null,
}));

mock.module("@/lib/github/pulls", () => ({
  findDeploymentUrl: async () => ({ success: false }),
  findPullRequest: async () => ({ found: false }),
  getMergeReadiness: async () => {
    throw new Error("merge readiness should not be fetched in this test");
  },
}));

const modulePromise = import("./pr");

describe("GitHub PR query session authorization", () => {
  beforeEach(() => {
    requireSessionAccessMock.mockClear();
    sessionRecord = {
      id: "session-1",
      userId: "creator-user",
      sandboxState: null,
      branch: "feature/shared",
      prNumber: 12,
      prStatus: "open",
      repoOwner: null,
      repoName: null,
      cloneUrl: null,
    };
  });

  test("checkPullRequest allows a shared non-creator through write authz", async () => {
    const { checkPullRequest } = await modulePromise;

    await expect(checkPullRequest({ sessionId: "session-1" })).resolves.toEqual({
      branch: "feature/shared",
      prNumber: 12,
      prStatus: "open",
    });

    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "write",
    );
  });

  test("getMergeReadiness allows a shared non-creator through read authz", async () => {
    const { getMergeReadiness } = await modulePromise;

    const result = await getMergeReadiness({ sessionId: "session-1" });

    expect(result.canMerge).toBe(false);
    expect(result.reasons).toEqual(["Session is not linked to a GitHub repository"]);
    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "read",
    );
  });
});
