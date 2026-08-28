import { PAUSED_APPROVAL_TIMEOUT_MS } from "@executor-js/host-mcp/tool-server";

/** Idle timeout for MCP sessions with no paused continuations. */
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Lease extension while paused executions block hibernation (matches browser approval wait). */
export const PAUSED_EXECUTION_LEASE_MS = PAUSED_APPROVAL_TIMEOUT_MS;

/** Lease extension while requests or client streams are still active. */
export const RUNNING_EXECUTION_LEASE_MS = PAUSED_APPROVAL_TIMEOUT_MS;

/**
 * Hard upper bound on idle time before a paused session is torn down regardless
 * of outstanding paused work. The lease grants a single approval window of grace
 * past the idle timeout — once it elapses the browser approval wait has already
 * timed out (see tool-server `waitForBrowserApprovalResponse`), so the paused
 * execution is no longer resumable and the DO must not keep extending forever.
 */
export const MAX_PAUSED_SESSION_IDLE_MS = SESSION_TIMEOUT_MS + PAUSED_EXECUTION_LEASE_MS;

/** Matches the patched agents transport's MAX_SSE_AGE_MS (30 minutes). */
const SSE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Hard upper bound on idle time while running work or open streams keep
 * extending the lease. Running executions are already bounded by the runtime's
 * own execution timeout and open streams by the SSE max-age rotation, so this
 * ceiling is a structural backstop for the case where neither bound fires
 * (a wedged execution that never sends, or a stream close event workerd never
 * delivers). It sits one full SSE max-age window past the idle timeout so a
 * legitimately connected-but-quiet client stream is never cut before its
 * scheduled rotation.
 */
export const MAX_RUNNING_SESSION_IDLE_MS = SESSION_TIMEOUT_MS + SSE_MAX_AGE_MS;

export type SessionAlarmDecision =
  | { readonly kind: "idle_within_timeout" }
  | { readonly kind: "destroy_idle_session" }
  | { readonly kind: "extend_paused_lease"; readonly leaseMs: number }
  | { readonly kind: "extend_running_lease"; readonly leaseMs: number };

export const decideSessionAlarm = (input: {
  readonly idleMs: number;
  readonly pausedExecutionCount: number;
  readonly runningExecutionCount?: number;
  readonly activeStreamCount?: number;
  readonly sessionTimeoutMs?: number;
  readonly maxPausedSessionIdleMs?: number;
  readonly maxRunningSessionIdleMs?: number;
}): SessionAlarmDecision => {
  const sessionTimeoutMs = input.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const maxPausedSessionIdleMs = input.maxPausedSessionIdleMs ?? MAX_PAUSED_SESSION_IDLE_MS;
  const maxRunningSessionIdleMs = input.maxRunningSessionIdleMs ?? MAX_RUNNING_SESSION_IDLE_MS;
  if (input.idleMs < sessionTimeoutMs) {
    return { kind: "idle_within_timeout" };
  }
  if (input.pausedExecutionCount > 0) {
    // Paused work expires on its own clock, full stop. A paused execution's
    // originating POST also leaves an un-responded request id (and often an
    // open client stream), so the running-lease branch below would otherwise
    // keep the runtime warm past the paused ceiling and a stale approval
    // would silently resume. Once maxPausedSessionIdleMs elapses the browser
    // approval wait has already timed out and the product contract is an
    // expired-resume error with re-run guidance, so the session is destroyed
    // regardless of running work or open streams.
    if (input.idleMs < maxPausedSessionIdleMs) {
      return {
        kind: "extend_paused_lease",
        leaseMs: Math.max(
          1,
          Math.min(PAUSED_EXECUTION_LEASE_MS, maxPausedSessionIdleMs - input.idleMs),
        ),
      };
    }
    return { kind: "destroy_idle_session" };
  }
  if (
    ((input.runningExecutionCount ?? 0) > 0 || (input.activeStreamCount ?? 0) > 0) &&
    input.idleMs < maxRunningSessionIdleMs
  ) {
    return {
      kind: "extend_running_lease",
      leaseMs: Math.max(
        1,
        Math.min(RUNNING_EXECUTION_LEASE_MS, maxRunningSessionIdleMs - input.idleMs),
      ),
    };
  }
  return { kind: "destroy_idle_session" };
};

export const pausedLeaseExtensionLog = (input: {
  readonly sessionId: string;
  readonly pausedExecutionCount: number;
  readonly idleMs: number;
  readonly leaseMs: number;
}): Record<string, unknown> => ({
  event: "mcp_session_paused_lease_extension",
  sessionId: input.sessionId,
  pausedExecutionCount: input.pausedExecutionCount,
  idleMs: input.idleMs,
  leaseMs: input.leaseMs,
});

export const runningLeaseExtensionLog = (input: {
  readonly sessionId: string;
  readonly runningExecutionCount: number;
  readonly activeStreamCount: number;
  readonly idleMs: number;
  readonly leaseMs: number;
}): Record<string, unknown> => ({
  event: "mcp_session_running_lease_extension",
  sessionId: input.sessionId,
  runningExecutionCount: input.runningExecutionCount,
  activeStreamCount: input.activeStreamCount,
  idleMs: input.idleMs,
  leaseMs: input.leaseMs,
});
