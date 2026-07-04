const DEFAULT_E2E_MCP_SESSION_TIMEOUT_MS = 3_000;
const DEFAULT_E2E_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS = 6_000;
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
