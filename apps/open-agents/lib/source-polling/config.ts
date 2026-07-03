const DEFAULT_SOURCE_POLLING_INTERVAL_MS = 60_000;
const MIN_SOURCE_POLLING_INTERVAL_MS = 10_000;

function readBooleanEnv(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return null;
}

function readPositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isSourcePollingGloballyEnabled(): boolean {
  return readBooleanEnv("OPEN_AGENTS_SOURCE_POLLING_ENABLED") !== false;
}

export function getSourcePollingIntervalMs(): number {
  return Math.max(
    readPositiveIntegerEnv("OPEN_AGENTS_SOURCE_POLL_INTERVAL_MS") ??
      DEFAULT_SOURCE_POLLING_INTERVAL_MS,
    MIN_SOURCE_POLLING_INTERVAL_MS,
  );
}

export function getSourcePollingLeaseTtlMs(): number {
  return Math.max(getSourcePollingIntervalMs() * 3, 180_000);
}
