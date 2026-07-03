import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockAuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

const execMock = mock(async (command: string) => ({
  success: true,
  stdout: command.startsWith("git symbolic-ref") ? "feature/shared\n" : "",
  stderr: "",
}));
const connectSandboxMock = mock(async () => ({
  workingDirectory: "/vercel/sandbox",
  exec: execMock,
}));
const updateSessionMock = mock(async () => undefined);
const requireSessionAccessMock = mock(async () => ({ scopeKind: "group", scopeId: "group-1" }));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: connectSandboxMock,
}));
mock.module("@open-agents/authz", () => ({
  AuthzError: MockAuthzError,
  requireSessionAccess: requireSessionAccessMock,
}));
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => ({
    user: { id: "viewer-user", username: "viewer", name: "Viewer" },
  }),
}));
mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => ({
    id: "session-1",
    userId: "creator-user",
    sandboxState: {
      type: "vercel",
      sandboxName: "sandbox-1",
      expiresAt: Date.now() + 3_600_000,
    },
  }),
  updateSession: updateSessionMock,
}));

const branchModulePromise = import("./branch");

describe("createBranch", () => {
  beforeEach(() => {
    execMock.mockClear();
    connectSandboxMock.mockClear();
    updateSessionMock.mockClear();
    requireSessionAccessMock.mockClear();
  });

  test("allows a shared non-creator when authz grants write access", async () => {
    const { createBranch } = await branchModulePromise;

    const result = await createBranch({
      sessionId: "session-1",
      sessionTitle: "Shared Session",
      baseBranch: "main",
      branchName: "feature/shared",
    });

    expect(result).toEqual({ branchName: "feature/shared" });
    expect(requireSessionAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "viewer-user" },
      "session-1",
      "write",
    );
    expect(connectSandboxMock).toHaveBeenCalledTimes(1);
  });
});
