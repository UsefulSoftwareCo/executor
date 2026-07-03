import type { SandboxState } from "@open-agents/sandbox";
import {
  SANDBOX_EXPIRES_BUFFER_MS,
  SANDBOX_INACTIVITY_TIMEOUT_MS,
} from "./config";

export type SandboxLifecycleState =
  | "provisioning"
  | "active"
  | "hibernating"
  | "hibernated"
  | "restoring"
  | "archived"
  | "failed";

export type SandboxLifecycleReason =
  | "sandbox-created"
  | "timeout-extended"
  | "sandbox-resumed"
  | "reconnect"
  | "manual-stop"
  | "status-check-overdue";

export interface SandboxLifecycleEvaluationResult {
  action: "skipped" | "hibernated" | "failed";
  reason?: string;
}

export interface SandboxLifecycleUpdate {
  lifecycleState?: SandboxLifecycleState;
  lifecycleError?: string | null;
  lastActivityAt?: Date;
  hibernateAfter?: Date | null;
  sandboxExpiresAt?: Date | null;
  lifecycleRunId?: string | null;
}

interface LifecycleTimingSource {
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
  sandboxExpiresAt: Date | null;
  updatedAt: Date;
}

export function getNextLifecycleVersion(
  currentVersion: number | null | undefined,
): number {
  return (currentVersion ?? 0) + 1;
}

export function getSandboxExpiresAtMs(
  sandboxState: SandboxState | null | undefined,
): number | undefined {
  if (!sandboxState || !("expiresAt" in sandboxState)) {
    return undefined;
  }
  return typeof sandboxState.expiresAt === "number"
    ? sandboxState.expiresAt
    : undefined;
}

export function getSandboxExpiresAtDate(
  sandboxState: SandboxState | null | undefined,
): Date | null {
  const expiresAtMs = getSandboxExpiresAtMs(sandboxState);
  return expiresAtMs === undefined ? null : new Date(expiresAtMs);
}

export function buildLifecycleActivityUpdate(
  activityAt: Date = new Date(),
  lifecycleState: Extract<
    SandboxLifecycleState,
    "active" | "restoring"
  > = "active",
): Pick<
  SandboxLifecycleUpdate,
  "lifecycleState" | "lifecycleError" | "lastActivityAt" | "hibernateAfter"
> {
  return {
    lifecycleState,
    lifecycleError: null,
    lastActivityAt: activityAt,
    hibernateAfter: new Date(
      activityAt.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS,
    ),
  };
}

export function buildActiveLifecycleUpdate(
  sandboxState: SandboxState | null | undefined,
  options?: {
    activityAt?: Date;
    lifecycleState?: Extract<SandboxLifecycleState, "active" | "restoring">;
  },
): SandboxLifecycleUpdate {
  const activityAt = options?.activityAt ?? new Date();

  return {
    ...buildLifecycleActivityUpdate(
      activityAt,
      options?.lifecycleState ?? "active",
    ),
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  };
}

export function buildHibernatedLifecycleUpdate(): SandboxLifecycleUpdate {
  return {
    lifecycleState: "hibernated",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  };
}

function getInactivityDueAtMs(source: LifecycleTimingSource): number {
  if (source.hibernateAfter) {
    return source.hibernateAfter.getTime();
  }

  const lastActivityMs =
    source.lastActivityAt?.getTime() ?? source.updatedAt.getTime();
  return lastActivityMs + SANDBOX_INACTIVITY_TIMEOUT_MS;
}

function getExpiryDueAtMs(source: LifecycleTimingSource): number | null {
  if (!source.sandboxExpiresAt) {
    return null;
  }
  return source.sandboxExpiresAt.getTime() - SANDBOX_EXPIRES_BUFFER_MS;
}

export function getLifecycleDueAtMs(source: LifecycleTimingSource): number {
  const inactivityDueAtMs = getInactivityDueAtMs(source);
  const expiryDueAtMs = getExpiryDueAtMs(source);
  if (expiryDueAtMs === null) {
    return inactivityDueAtMs;
  }
  return Math.min(inactivityDueAtMs, expiryDueAtMs);
}
