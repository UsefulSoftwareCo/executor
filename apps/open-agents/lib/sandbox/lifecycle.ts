import "server-only";

import { connectSandbox, type SandboxState } from "@open-agents/sandbox";
import {
  getChatsBySessionId,
  getEveChatStreamingStatuses,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  buildHibernatedLifecycleUpdate,
  getLifecycleDueAtMs,
  getSandboxExpiresAtDate,
  type SandboxLifecycleEvaluationResult,
  type SandboxLifecycleReason,
} from "./lifecycle-state";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getPersistentSandboxName,
} from "./utils";

async function hasActiveStreamForSession(sessionId: string): Promise<boolean> {
  const chatsInSession = await getChatsBySessionId(sessionId);
  const streamingStatuses = await getEveChatStreamingStatuses(
    chatsInSession.map((chat) => chat.id),
  );
  return chatsInSession.some((chat) => streamingStatuses.get(chat.id) ?? false);
}

async function restoreActiveLifecycleState(
  sessionId: string,
  sandboxState: SandboxState,
): Promise<void> {
  await updateSession(sessionId, {
    lifecycleState: "active",
    lifecycleError: null,
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  });
}

/**
 * One-shot lifecycle evaluator for workflow orchestration.
 *
 * This performs a single evaluation pass and exits.
 * The durable workflow loops and calls this when it wakes.
 */
export async function evaluateSandboxLifecycle(
  sessionId: string,
  reason: SandboxLifecycleReason,
): Promise<SandboxLifecycleEvaluationResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { action: "skipped", reason: "session-not-found" };
  }

  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { action: "skipped", reason: "session-archived" };
  }

  const sandboxState = session.sandboxState;
  if (!canOperateOnSandbox(sandboxState)) {
    return { action: "skipped", reason: "sandbox-not-operable" };
  }
  if (sandboxState.type !== "vercel") {
    return { action: "skipped", reason: "unsupported-sandbox-type" };
  }

  const nowMs = Date.now();
  const dueAtMs = getLifecycleDueAtMs(session);
  const isInactive = nowMs >= dueAtMs;

  if (!isInactive) {
    return { action: "skipped", reason: "not-due-yet" };
  }

  if (await hasActiveStreamForSession(sessionId)) {
    return { action: "skipped", reason: "active-workflow" };
  }

  try {
    await updateSession(sessionId, {
      lifecycleState: "hibernating",
      lifecycleError: null,
    });

    const sandbox = await connectSandbox(sandboxState);

    if (await hasActiveStreamForSession(sessionId)) {
      await restoreActiveLifecycleState(sessionId, sandboxState);
      return { action: "skipped", reason: "active-workflow" };
    }

    const refreshedSession = await getSessionById(sessionId);
    if (
      refreshedSession?.sandboxState &&
      canOperateOnSandbox(refreshedSession.sandboxState)
    ) {
      const lifecycleTimingChanged =
        refreshedSession.lastActivityAt?.getTime() !==
          session.lastActivityAt?.getTime() ||
        refreshedSession.hibernateAfter?.getTime() !==
          session.hibernateAfter?.getTime() ||
        refreshedSession.sandboxExpiresAt?.getTime() !==
          session.sandboxExpiresAt?.getTime();

      if (
        lifecycleTimingChanged &&
        Date.now() < getLifecycleDueAtMs(refreshedSession)
      ) {
        await restoreActiveLifecycleState(
          sessionId,
          refreshedSession.sandboxState,
        );
        return { action: "skipped", reason: "not-due-yet" };
      }
    }

    await sandbox.stop();

    const clearedState = clearSandboxState(sandboxState);
    await updateSession(sessionId, {
      sandboxState: clearedState,
      ...buildHibernatedLifecycleUpdate(),
    });
    console.log(
      `[Lifecycle] Hibernated sandbox for session ${sessionId} (reason=${reason}, sandboxName=${getPersistentSandboxName(clearedState) ?? "none"}).`,
    );
    return { action: "hibernated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleRunId: null,
      lifecycleError: message,
    });
    console.error(
      `[Lifecycle] Failed to evaluate sandbox lifecycle for session ${sessionId}:`,
      error,
    );
    return { action: "failed", reason: message };
  }
}
