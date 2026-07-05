import { describe, expect, it } from "@effect/vitest";

import {
  isToolsSyncBackoffPending,
  nextToolsSyncFailureBackoff,
  resetToolsSyncBackoffPatch,
  TOOLS_SYNC_BACKOFF_CAP_MS,
} from "./tool-sync-backoff";

describe("tool sync backoff", () => {
  it("increments failures and doubles the retry delay until the cap", () => {
    const nowMs = 1_000_000;
    const baseMs = 15 * 60 * 1000;

    const first = nextToolsSyncFailureBackoff({ failureCount: null, baseMs, nowMs });
    expect(first).toEqual({
      failureCount: 1,
      delayMs: baseMs,
      retryAfter: nowMs + baseMs,
    });

    const second = nextToolsSyncFailureBackoff({
      failureCount: first.failureCount,
      baseMs,
      nowMs,
    });
    expect(second).toEqual({
      failureCount: 2,
      delayMs: baseMs * 2,
      retryAfter: nowMs + baseMs * 2,
    });

    const capped = nextToolsSyncFailureBackoff({ failureCount: 100, baseMs, nowMs });
    expect(capped.failureCount).toBe(101);
    expect(capped.delayMs).toBe(TOOLS_SYNC_BACKOFF_CAP_MS);
    expect(capped.retryAfter).toBe(nowMs + TOOLS_SYNC_BACKOFF_CAP_MS);
  });

  it("detects pending retry windows and exposes the success reset patch", () => {
    expect(isToolsSyncBackoffPending(10_001, 10_000)).toBe(true);
    expect(isToolsSyncBackoffPending(10_000, 10_000)).toBe(false);
    expect(resetToolsSyncBackoffPatch).toEqual({
      tools_sync_failure_count: null,
      tools_sync_retry_after: null,
    });
  });
});
