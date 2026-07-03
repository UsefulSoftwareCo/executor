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

const connectCalls: Array<{ state: Record<string, unknown> }> = [];
const updateCalls: Array<Record<string, unknown>> = [];

let stopCallCount = 0;
let sessionRecord: TestSessionRecord;

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => ({
    ok: true as const,
    userId: "user-1",
  }),
  requireOwnedSessionWithSandboxGuard: async ({
    sandboxGuard,
  }: {
    sandboxGuard: (state: TestSandboxState | null) => boolean;
  }) =>
    sandboxGuard(sessionRecord.sandboxState)
      ? ({ ok: true as const, sessionRecord } as const)
      : ({
          ok: false as const,
          response: Response.json(
            { error: "Sandbox not initialized" },
            { status: 400 },
          ),
        } as const),
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

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (state: Record<string, unknown>) => {
    connectCalls.push({ state });

    return {
      stop: async () => {
        stopCallCount += 1;
      },
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

describe("/api/sandbox/pause", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    updateCalls.length = 0;
    stopCallCount = 0;
    sessionRecord = makeSessionRecord();
  });

  test("POST pauses a named persistent sandbox", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sandbox/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
    const payload = (await response.json()) as {
      sandboxName: string | null;
    };

    expect(response.ok).toBe(true);
    expect(stopCallCount).toBe(1);
    expect(payload.sandboxName).toBe("session_session-1");
    expect(connectCalls[0]).toMatchObject({
      state: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
    });
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        sandboxState: {
          type: "vercel",
          sandboxName: "session_session-1",
        },
        lifecycleVersion: 3,
        lifecycleState: "hibernated",
      }),
    );
  });
});
