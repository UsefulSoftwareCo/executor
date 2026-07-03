import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type TestSandboxState = {
  type: "vercel";
  sandboxName?: string;
  expiresAt?: number;
};

type TestSessionRecord = {
  id: string;
  userId: string;
  sandboxState: TestSandboxState | null;
  lifecycleVersion: number;
  lifecycleState: string | null;
  sandboxExpiresAt: Date | null;
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
};

const connectCalls: Array<{
  state: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const kickCalls: Array<{ sessionId: string; reason: string }> = [];

let connectSandboxResumeError: Error | null = null;
let sessionRecord: TestSessionRecord;

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => ({
    ok: true as const,
    userId: "user-1",
  }),
  requireOwnedSession: async () => ({ ok: true as const, sessionRecord }),
}));

mock.module("@/lib/db/sessions", () => ({
  getChatsBySessionId: async () => [],
  getEveChatStreamingStatuses: async () => new Map(),
  getSessionById: async () => sessionRecord,
  updateSession: async (_sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    sessionRecord = {
      ...sessionRecord,
      ...(patch as Partial<TestSessionRecord>),
    };
    return sessionRecord;
  },
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: {
    sessionId: string;
    reason: string;
  }) => {
    kickCalls.push(input);
  },
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (
    state: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    connectCalls.push({ state, options });

    if (
      connectSandboxResumeError &&
      options?.resume === true &&
      typeof state.sandboxName === "string"
    ) {
      throw connectSandboxResumeError;
    }

    const sandboxName =
      typeof state.sandboxName === "string"
        ? state.sandboxName
        : "session_session-1";
    return {
      id: "runtime-1",
      expiresAt: Date.now() + 120_000,
      workingDirectory: "/vercel/sandbox",
      getState: () => ({
        type: "vercel" as const,
        sandboxName,
        expiresAt: Date.now() + 120_000,
      }),
    };
  },
}));

const routeModulePromise = import("./route");

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    },
    lifecycleVersion: 2,
    lifecycleState: "active",
    sandboxExpiresAt: new Date(Date.now() + 60_000),
    hibernateAfter: new Date(Date.now() + 30_000),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

describe("/api/sandbox/resume", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    updateCalls.length = 0;
    kickCalls.length = 0;
    connectSandboxResumeError = null;
    sessionRecord = makeSessionRecord();
  });

  test("PUT resumes an existing named persistent sandbox", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/resume", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      options: {
        resume: true,
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: expect.objectContaining({
          type: "vercel",
          sandboxName: "session_session-1",
        }),
        lifecycleVersion: 3,
      }),
    );
    expect(kickCalls).toEqual([
      { sessionId: "session-1", reason: "sandbox-resumed" },
    ]);
  });

  test("PUT clears a broken persistent sandbox handle after a 404", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });
    connectSandboxResumeError = new Error("Status code 404 is not ok");

    const response = await PUT(
      new Request("http://localhost/api/sandbox/resume", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(payload.error).toContain("Saved sandbox is no longer available");
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: {
          type: "vercel",
        },
        lifecycleState: "hibernated",
      }),
    );
  });

  test("PUT rejects sessions without a persistent sandbox name", async () => {
    const { PUT } = await routeModulePromise;

    sessionRecord = makeSessionRecord({
      sandboxState: { type: "vercel" },
      lifecycleState: "hibernated",
      sandboxExpiresAt: null,
      hibernateAfter: null,
    });

    const response = await PUT(
      new Request("http://localhost/api/sandbox/resume", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(payload.error).toBe("No sandbox available for resume");
    expect(connectCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(kickCalls).toHaveLength(0);
  });
});
