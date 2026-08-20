const DEFAULT_E2E_MCP_SESSION_TIMEOUT_MS = 3_000;
// A paused execution must outlive a HUMAN deciding on it, and the browser
// approval scenario is the one that measures what that costs: on a loaded CI
// runner, page load to Approve click was 8.7s (the resume page reads the
// session once on load, so nothing keeps the pause warm in between). At 6s the
// approval POST came back 404 and the scenario failed on "Approve sent" — 12
// shards in the two weeks to 2026-08-20 — with the page showing "this paused
// execution is no longer available", which is a fixture too tight for the
// journey, not a product fault. Production allows 9 minutes.
//
// The cost of raising it is paid in ONE place: cloud/mcp-client-sessions
// derives its teardown wait from this value, so the expiry scenario now sleeps
// this much longer. That is the trade — seconds on one scenario against a
// 30-second timeout plus a re-run of the whole matrix.
const DEFAULT_E2E_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS = 30_000;
const PRODUCTION_MCP_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const PRODUCTION_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS = 9 * 60 * 1000;

export const MCP_SESSION_TIMEOUT_ENV = "MCP_SESSION_TIMEOUT_MS";
export const MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV = "MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS";

const positiveMilliseconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

export const ensureE2eMcpSessionTimeoutEnv = (): {
  readonly sessionTimeoutMs: number;
  readonly pausedSessionIdleTimeoutMs: number;
} => {
  const sessionTimeoutMs =
    positiveMilliseconds(process.env[MCP_SESSION_TIMEOUT_ENV]) ??
    DEFAULT_E2E_MCP_SESSION_TIMEOUT_MS;
  const pausedSessionIdleTimeoutMs =
    positiveMilliseconds(process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV]) ??
    DEFAULT_E2E_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS;

  process.env[MCP_SESSION_TIMEOUT_ENV] = String(sessionTimeoutMs);
  process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV] = String(pausedSessionIdleTimeoutMs);

  return { sessionTimeoutMs, pausedSessionIdleTimeoutMs };
};

export const configuredMcpPausedSessionIdleTimeoutMs = (): number =>
  positiveMilliseconds(process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV]) ??
  PRODUCTION_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS;

export const configuredMcpSessionTimeoutMs = (): number =>
  positiveMilliseconds(process.env[MCP_SESSION_TIMEOUT_ENV]) ?? PRODUCTION_MCP_SESSION_TIMEOUT_MS;
