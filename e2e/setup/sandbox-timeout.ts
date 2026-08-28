// The sandbox execution budget shared between a target's boot env and the
// sandbox-deadline scenario, so they cannot drift apart (same pattern as
// execution-limits.ts). The scenario proves a RATIO — approvals granted
// inside their own windows survive an execution that outlives the sandbox's
// absolute budget — so the budget's magnitude is free to shrink: on selfhost
// the boot recipe passes E2E_SANDBOX_TIMEOUT_MS through to the server as
// EXECUTOR_SANDBOX_TIMEOUT_MS and the scenario scales its approval delays to
// match, turning a ~6-minute real-time wait into seconds. Targets that cannot
// shrink the budget (cloud's dynamic-worker deadline is not env-tunable) run
// against the production default and skip via their paused-session window
// guard instead.
export const E2E_SANDBOX_TIMEOUT_MS = 20_000;

export const SANDBOX_TIMEOUT_ENV = "E2E_SANDBOX_TIMEOUT_MS";

const PRODUCTION_SANDBOX_TIMEOUT_MS = 5 * 60_000;

const positiveMilliseconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

/** The sandbox budget the current target enforces: the harness override when
 *  the target was booted with one, else the production default. */
export const configuredSandboxTimeoutMs = (): number =>
  positiveMilliseconds(process.env[SANDBOX_TIMEOUT_ENV]) ?? PRODUCTION_SANDBOX_TIMEOUT_MS;
