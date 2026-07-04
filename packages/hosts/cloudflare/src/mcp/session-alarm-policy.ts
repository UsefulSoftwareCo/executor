import { PAUSED_APPROVAL_TIMEOUT_MS } from "@executor-js/host-mcp/tool-server";

/** Idle timeout for MCP sessions with no paused continuations. */
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Lease extension while paused executions block hibernation (matches browser approval wait). */
export const PAUSED_EXECUTION_LEASE_MS = PAUSED_APPROVAL_TIMEOUT_MS;

/**
 * Hard upper bound on idle time before a paused session is torn down regardless
 * of outstanding paused work. The lease grants a single approval window of grace
 * past the idle timeout — once it elapses the browser approval wait has already
 * timed out (see tool-server `waitForBrowserApprovalResponse`), so the paused
 * execution is no longer resumable and the DO must not keep extending forever.
 */
export const MAX_PAUSED_SESSION_IDLE_MS = SESSION_TIMEOUT_MS + PAUSED_EXECUTION_LEASE_MS;

export type SessionAlarmDecision =
  | { readonly kind: "idle_within_timeout" }
  | { readonly kind: "destroy_idle_session" }
  | { readonly kind: "extend_paused_lease"; readonly leaseMs: number };

export const decideSessionAlarm = (input: {
  readonly idleMs: number;
  readonly pausedExecutionCount: number;
  readonly sessionTimeoutMs?: number;
  readonly maxPausedSessionIdleMs?: number;
}): SessionAlarmDecision => {
  const sessionTimeoutMs = input.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const maxPausedSessionIdleMs = input.maxPausedSessionIdleMs ?? MAX_PAUSED_SESSION_IDLE_MS;
  if (input.idleMs < sessionTimeoutMs) {
    return { kind: "idle_within_timeout" };
  }
  if (input.pausedExecutionCount > 0 && input.idleMs < maxPausedSessionIdleMs) {
    return {
      kind: "extend_paused_lease",
      leaseMs: Math.max(
        1,
        Math.min(PAUSED_EXECUTION_LEASE_MS, maxPausedSessionIdleMs - input.idleMs),
      ),
    };
  }
  return { kind: "destroy_idle_session" };
};
