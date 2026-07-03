import "server-only";

import { start } from "workflow/api";
import { sandboxLifecycleWorkflow } from "@/app/workflows/sandbox-lifecycle";
import { claimSessionLifecycleRunId, getSessionById, updateSession } from "@/lib/db/sessions";
import { SANDBOX_LIFECYCLE_STALE_RUN_GRACE_MS } from "./config";
import { getLifecycleDueAtMs, type SandboxLifecycleReason } from "./lifecycle-state";
import { canOperateOnSandbox } from "./utils";

interface KickSandboxLifecycleInput {
  sessionId: string;
  reason: SandboxLifecycleReason;
  scheduleBackgroundWork?: (callback: () => Promise<void>) => void;
}

async function startLifecycleRun(sessionId: string, reason: SandboxLifecycleReason, runId: string) {
  const run = await start(sandboxLifecycleWorkflow, [sessionId, reason, runId]);
  console.log(
    `[Lifecycle] Started workflow run ${run.runId} for session ${sessionId} (reason=${reason}, lease=${runId}).`,
  );
}

function createLifecycleRunId(): string {
  return `lifecycle:${Date.now()}:${crypto.randomUUID()}`;
}

function shouldStartLifecycle(
  session: Awaited<ReturnType<typeof getSessionById>>,
): session is NonNullable<Awaited<ReturnType<typeof getSessionById>>> {
  if (!session) {
    return false;
  }
  if (session.status === "archived" || session.lifecycleState === "archived") {
    return false;
  }
  if (!session.sandboxState) {
    return false;
  }
  if (!canOperateOnSandbox(session.sandboxState)) {
    return false;
  }
  if (session.sandboxState.type !== "vercel") {
    return false;
  }
  if (session.lifecycleRunId) {
    return false;
  }

  return true;
}

function isLifecycleRunStale(
  session: NonNullable<Awaited<ReturnType<typeof getSessionById>>>,
): boolean {
  if (!session.lifecycleRunId) {
    return false;
  }
  if (session.lifecycleState !== "active") {
    return false;
  }

  const dueAtMs = getLifecycleDueAtMs(session);
  const overdueMs = Date.now() - dueAtMs;

  return overdueMs > SANDBOX_LIFECYCLE_STALE_RUN_GRACE_MS;
}

export function kickSandboxLifecycleWorkflow(input: KickSandboxLifecycleInput) {
  const run = async () => {
    const session = await getSessionById(input.sessionId);
    if (!session) {
      return;
    }

    const sessionForStart = isLifecycleRunStale(session)
      ? { ...session, lifecycleRunId: null }
      : session;

    if (sessionForStart !== session) {
      await updateSession(input.sessionId, { lifecycleRunId: null });
    }

    if (!shouldStartLifecycle(sessionForStart)) {
      return;
    }

    const runId = createLifecycleRunId();
    const claimed = await claimSessionLifecycleRunId(input.sessionId, runId);
    if (!claimed) {
      return;
    }

    await startLifecycleRun(input.sessionId, input.reason, runId);
  };

  if (input.scheduleBackgroundWork) {
    input.scheduleBackgroundWork(run);
    return;
  }

  void run();
}
