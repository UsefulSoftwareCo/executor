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

mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireChatAccess: async () => ({ scopeKind: "group", scopeId: "group-1" }),
  requireSessionAccess: requireSessionAccessMock,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({ user: { id: "viewer-user" } }),
}));

mock.module("@/lib/db/sessions", () => ({
  createChat: async () => undefined,
  getChatById: async () => null,
  getChatSummariesBySessionId: async () => [],
  getSessionById: async () => ({
    id: "session-1",
    userId: "creator-user",
    branch: "feature/shared",
    prNumber: null,
    repoOwner: null,
    repoName: null,
    vercelProjectId: null,
    vercelTeamId: null,
  }),
}));

mock.module("@/lib/github/token", () => ({
  getUserGitHubToken: async () => null,
}));

mock.module("@/lib/vercel/token", () => ({
  getUserVercelToken: async () => null,
}));

mock.module("@/lib/github/pulls", () => ({
  findDeploymentUrl: async () => {
    throw new Error("deployment comments should not be fetched in this test");
  },
  findPullRequest: async () => ({ found: false }),
  getMergeReadiness: async () => {
    throw new Error("merge readiness should not be fetched in this test");
  },
}));

mock.module("@/lib/vercel/projects", () => ({
  findLatestPreviewDeploymentUrlForBranch: async () => null,
  findLatestBuildingDeploymentUrlForBranch: async () => null,
  findLatestFailedDeploymentInspectorUrlForBranch: async () => null,
}));

const modulePromise = import("./deployment");

describe("deployment query session authorization", () => {
  beforeEach(() => {
    requireSessionAccessMock.mockClear();
  });

  test("allows a shared non-creator through read authz", async () => {
    const { getDeploymentUrl } = await modulePromise;

    await expect(getDeploymentUrl({ sessionId: "session-1" })).resolves.toEqual({
      deploymentUrl: null,
    });

    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "read",
    );
  });
});
