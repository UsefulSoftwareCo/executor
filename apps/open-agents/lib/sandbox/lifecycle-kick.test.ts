import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type TestSessionRecord = {
  id: string;
  status: "running" | "completed" | "failed" | "archived";
  lifecycleState:
    | "provisioning"
    | "active"
    | "hibernating"
    | "hibernated"
    | "restoring"
    | "archived"
    | "failed";
  sandboxState: {
    type: "vercel";
    sandboxName: string;
  } | null;
  lifecycleRunId: string | null;
};

let sessionRecord: TestSessionRecord | null = null;
const scheduledCallbacks: Array<() => Promise<void>> = [];

const sandboxLifecycleWorkflow = Symbol("sandboxLifecycleWorkflow");

async function startWorkflow(
  _workflow: typeof sandboxLifecycleWorkflow,
  _args: [string, string, string],
) {
  return { runId: "workflow-run-1" };
}

const spies = {
  start: mock(startWorkflow),
  claimSessionLifecycleRunId: mock(async (sessionId: string, runId: string) => {
    if (!sessionRecord || sessionRecord.id !== sessionId || sessionRecord.lifecycleRunId !== null) {
      return false;
    }

    sessionRecord = {
      ...sessionRecord,
      lifecycleRunId: runId,
    };
    return true;
  }),
  getSessionById: mock(async () =>
    sessionRecord
      ? {
          ...sessionRecord,
          sandboxState: sessionRecord.sandboxState ? { ...sessionRecord.sandboxState } : null,
        }
      : null,
  ),
  updateSession: mock(async (_sessionId: string, patch: Record<string, unknown>) => {
    if (!sessionRecord) {
      return null;
    }

    sessionRecord = {
      ...sessionRecord,
      ...patch,
    } as TestSessionRecord;
    return sessionRecord;
  }),
  getLifecycleDueAtMs: mock(() => Date.now()),
  canOperateOnSandbox: mock(() => true),
};

mock.module("workflow/api", () => ({
  start: spies.start,
}));

mock.module("@/app/workflows/sandbox-lifecycle", () => ({
  sandboxLifecycleWorkflow,
}));

mock.module("@/lib/db/sessions", () => ({
  claimSessionLifecycleRunId: spies.claimSessionLifecycleRunId,
  getSessionById: spies.getSessionById,
  updateSession: spies.updateSession,
}));

mock.module("./lifecycle-state", () => ({
  getLifecycleDueAtMs: spies.getLifecycleDueAtMs,
}));

mock.module("./utils", () => ({
  canOperateOnSandbox: spies.canOperateOnSandbox,
}));

const lifecycleKickModulePromise = import("./lifecycle-kick");

const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const consoleErrorSpy = mock(() => {});
const consoleLogSpy = mock(() => {});

afterAll(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

describe("kickSandboxLifecycleWorkflow", () => {
  beforeEach(() => {
    sessionRecord = {
      id: "session-1",
      status: "running",
      lifecycleState: "active",
      sandboxState: {
        type: "vercel",
        sandboxName: "sandbox-1",
      },
      lifecycleRunId: null,
    };
    scheduledCallbacks.length = 0;
    Object.values(spies).forEach((spy) => spy.mockClear());
    consoleErrorSpy.mockClear();
    consoleLogSpy.mockClear();
    console.error = consoleErrorSpy as typeof console.error;
    console.log = consoleLogSpy as typeof console.log;
  });

  test("claims the lifecycle lease before starting so overlapping kicks only start one workflow", async () => {
    const { kickSandboxLifecycleWorkflow } = await lifecycleKickModulePromise;

    const scheduleBackgroundWork = (callback: () => Promise<void>) => {
      scheduledCallbacks.push(callback);
    };

    kickSandboxLifecycleWorkflow({
      sessionId: "session-1",
      reason: "status-check-overdue",
      scheduleBackgroundWork,
    });
    kickSandboxLifecycleWorkflow({
      sessionId: "session-1",
      reason: "status-check-overdue",
      scheduleBackgroundWork,
    });

    expect(scheduledCallbacks).toHaveLength(2);

    await Promise.all(scheduledCallbacks.map((callback) => callback()));

    expect(spies.claimSessionLifecycleRunId).toHaveBeenCalledTimes(2);
    expect(spies.start).toHaveBeenCalledTimes(1);

    const startArgs = spies.start.mock.calls[0];
    expect(startArgs?.[0]).toBe(sandboxLifecycleWorkflow);
    expect(startArgs?.[1]).toEqual(["session-1", "status-check-overdue", expect.any(String)]);
    expect(sessionRecord?.lifecycleRunId).not.toBeNull();
  });
});
