export const TOOLS_SYNC_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000;

const normalizedCount = (value: unknown): number => {
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

export const nextToolsSyncFailureBackoff = (input: {
  readonly failureCount: unknown;
  readonly baseMs: number;
  readonly nowMs: number;
}): {
  readonly failureCount: number;
  readonly delayMs: number;
  readonly retryAfter: number;
} => {
  const failureCount = Math.min(normalizedCount(input.failureCount) + 1, Number.MAX_SAFE_INTEGER);
  const baseMs = Math.max(1, Math.trunc(input.baseMs));
  const exponent = Math.min(failureCount - 1, 52);
  const delayMs = Math.min(baseMs * 2 ** exponent, TOOLS_SYNC_BACKOFF_CAP_MS);
  return {
    failureCount,
    delayMs,
    retryAfter: input.nowMs + delayMs,
  };
};

export const isToolsSyncBackoffPending = (retryAfter: unknown, nowMs: number): boolean => {
  if (retryAfter == null) return false;
  const retryAfterMs =
    typeof retryAfter === "bigint"
      ? retryAfter > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(retryAfter)
      : Number(retryAfter);
  return Number.isFinite(retryAfterMs) && retryAfterMs > nowMs;
};

export const resetToolsSyncBackoffPatch = {
  tools_sync_failure_count: null,
  tools_sync_retry_after: null,
} as const;
