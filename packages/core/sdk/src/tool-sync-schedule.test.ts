import { describe, expect, it } from "@effect/vitest";

import {
  TOOL_SYNC_BACKOFF_CEILING_MS,
  TOOL_SYNC_CLAIM_LEASE_MS,
  TOOL_SYNC_JITTER_MAX,
  TOOL_SYNC_JITTER_MIN,
  classifyToolSync,
  decideToolSync,
  isSyncEligible,
  isToolSyncBackedOff,
  isToolSyncClaimLive,
  isToolSyncErrorKind,
  isToolSyncParked,
  scheduleAfterFailure,
  scheduleAfterSuccess,
  type ToolSyncCandidate,
} from "./tool-sync-schedule";

// The catalog sync lifecycle is a pure decision function, and these are the
// decisions it exists to make: what a persisted catalog IS, whether anyone is
// allowed to re-list it right now, and how long a failing connection is left
// alone. Testing it here rather than only through the executor is what keeps
// the ladder, the cap and the park rule honest without a database and a live
// upstream in the loop.

const NOW = 1_700_000_000_000;
const TTL = 15 * 60 * 1000;

/** A connection that has just synced successfully against a remote catalog. */
const fresh = (overrides: Partial<ToolSyncCandidate> = {}): ToolSyncCandidate => ({
  toolsSyncedAt: NOW - 1000,
  toolsStaleAt: null,
  toolsSyncClaimId: null,
  toolsSyncClaimAt: null,
  toolsSyncFailures: 0,
  toolsSyncRetryAt: null,
  toolsSyncErrorKind: null,
  configRevisedAt: null,
  remoteToolCatalog: true,
  ttlMs: TTL,
  ...overrides,
});

describe("isToolSyncErrorKind", () => {
  it("accepts exactly the four kinds", () => {
    expect(["auth", "unreachable", "protocol", "config"].every(isToolSyncErrorKind)).toBe(true);
  });

  it("rejects anything else a text column could hold", () => {
    for (const value of ["", "AUTH", "authentication", null, undefined, 401, {}]) {
      expect(isToolSyncErrorKind(value)).toBe(false);
    }
  });
});

describe("classifyToolSync", () => {
  it("calls a never-synced, never-marked connection cold", () => {
    expect(classifyToolSync(fresh({ toolsSyncedAt: null }), NOW)).toBe("cold");
  });

  it("calls a connection with a drift mark stale_marked, keeping its stamp", () => {
    const candidate = fresh({ toolsSyncedAt: NOW - 60_000, toolsStaleAt: NOW - 1000 });
    expect(classifyToolSync(candidate, NOW)).toBe("stale_marked");
  });

  it("still sees a drift mark that landed in the same millisecond as the stamp", () => {
    // Date.now() has millisecond granularity, and a `tools/list_changed`
    // arriving inside the millisecond it invalidates must not be swallowed.
    expect(classifyToolSync(fresh({ toolsSyncedAt: NOW, toolsStaleAt: NOW }), NOW)).toBe(
      "stale_marked",
    );
  });

  it("calls a never-synced connection carrying a drift mark stale_marked, not cold", () => {
    expect(classifyToolSync(fresh({ toolsSyncedAt: null, toolsStaleAt: NOW }), NOW)).toBe(
      "stale_marked",
    );
  });

  it("calls a catalog older than its integration's config revision config_revised", () => {
    expect(
      classifyToolSync(fresh({ toolsSyncedAt: NOW - 60_000, configRevisedAt: NOW - 30_000 }), NOW),
    ).toBe("config_revised");
  });

  it("leaves a catalog newer than the config revision alone", () => {
    expect(
      classifyToolSync(fresh({ toolsSyncedAt: NOW - 30_000, configRevisedAt: NOW - 60_000 }), NOW),
    ).toBe("fresh");
  });

  it("expires a remote catalog past the TTL", () => {
    expect(classifyToolSync(fresh({ toolsSyncedAt: NOW - TTL - 1 }), NOW)).toBe("expired");
  });

  it("never expires a catalog the plugin does not list remotely", () => {
    // An OpenAPI catalog is derived from a stored spec: time alone cannot make
    // it wrong, and re-listing it on a timer is pure waste.
    expect(
      classifyToolSync(fresh({ toolsSyncedAt: NOW - TTL - 1, remoteToolCatalog: false }), NOW),
    ).toBe("fresh");
  });

  it("never expires anything when the TTL is disabled", () => {
    expect(classifyToolSync(fresh({ toolsSyncedAt: 0, ttlMs: null }), NOW)).toBe("fresh");
  });

  it("ranks an explicit drift signal above a config revision and the clock", () => {
    const candidate = fresh({
      toolsSyncedAt: NOW - TTL - 1,
      toolsStaleAt: NOW,
      configRevisedAt: NOW - 1,
    });
    expect(classifyToolSync(candidate, NOW)).toBe("stale_marked");
  });

  it("ranks a config revision above the clock", () => {
    const candidate = fresh({ toolsSyncedAt: NOW - TTL - 1, configRevisedAt: NOW - 1 });
    expect(classifyToolSync(candidate, NOW)).toBe("config_revised");
  });
});

describe("isToolSyncClaimLive", () => {
  it("is false with no claim", () => {
    expect(isToolSyncClaimLive(fresh(), NOW)).toBe(false);
  });

  it("is true inside the lease", () => {
    const candidate = fresh({
      toolsSyncClaimId: "sync_abc",
      toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS + 1,
    });
    expect(isToolSyncClaimLive(candidate, NOW)).toBe(true);
  });

  it("is false once the lease has run out", () => {
    const candidate = fresh({
      toolsSyncClaimId: "sync_abc",
      toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS,
    });
    expect(isToolSyncClaimLive(candidate, NOW)).toBe(false);
  });

  it("treats a claim with no timestamp as dead rather than eternal", () => {
    // Otherwise a half-written row would lock a connection out of every future
    // refresh, forever, with nothing to expire it.
    const candidate = fresh({ toolsSyncClaimId: "sync_abc", toolsSyncClaimAt: null });
    expect(isToolSyncClaimLive(candidate, NOW)).toBe(false);
  });
});

describe("isToolSyncBackedOff", () => {
  it("holds a failing connection off until its retry instant", () => {
    const candidate = fresh({ toolsSyncFailures: 2, toolsSyncRetryAt: NOW + 1 });
    expect(isToolSyncBackedOff(candidate, NOW)).toBe(true);
    expect(isToolSyncBackedOff(candidate, NOW + 1)).toBe(false);
  });

  it("ignores the retry instant a SUCCESS wrote", () => {
    // After a success `tools_sync_retry_at` carries the freshness horizon, not
    // a gate: a drift signal arriving inside the window must heal the catalog
    // immediately instead of waiting the window out.
    const candidate = fresh({
      toolsSyncFailures: 0,
      toolsSyncRetryAt: NOW + TTL,
      toolsStaleAt: NOW,
    });
    expect(isToolSyncBackedOff(candidate, NOW)).toBe(false);
    expect(isSyncEligible(candidate, NOW)).toBe(true);
  });
});

describe("isToolSyncParked", () => {
  it("parks only on an auth verdict", () => {
    expect(isToolSyncParked(fresh({ toolsSyncErrorKind: "auth" }))).toBe(true);
    for (const kind of ["unreachable", "protocol", "config", null] as const) {
      expect(isToolSyncParked(fresh({ toolsSyncErrorKind: kind }))).toBe(false);
    }
  });
});

describe("isSyncEligible", () => {
  it("passes a due connection with a clear ledger, reporting what made it due", () => {
    expect(decideToolSync(fresh({ toolsSyncedAt: null }), NOW)).toEqual({
      kind: "refresh",
      trigger: "cold",
    });
    expect(isSyncEligible(fresh({ toolsSyncedAt: null }), NOW)).toBe(true);
  });

  it("skips a fresh connection", () => {
    expect(decideToolSync(fresh(), NOW)).toEqual({ kind: "skip", reason: "fresh" });
    expect(isSyncEligible(fresh(), NOW)).toBe(false);
  });

  it("skips a parked connection however overdue it is", () => {
    const candidate = fresh({
      toolsSyncedAt: null,
      toolsSyncFailures: 9,
      toolsSyncErrorKind: "auth",
      toolsSyncRetryAt: NOW - 1,
    });
    expect(decideToolSync(candidate, NOW)).toEqual({ kind: "skip", reason: "parked" });
    expect(isSyncEligible(candidate, NOW)).toBe(false);
  });

  it("skips a connection inside its backoff window", () => {
    const candidate = fresh({
      toolsSyncedAt: null,
      toolsSyncFailures: 1,
      toolsSyncErrorKind: "unreachable",
      toolsSyncRetryAt: NOW + 1,
    });
    expect(decideToolSync(candidate, NOW)).toEqual({ kind: "skip", reason: "backoff" });
  });

  it("skips a connection another attempt is already holding", () => {
    const candidate = fresh({
      toolsSyncedAt: null,
      toolsSyncClaimId: "sync_abc",
      toolsSyncClaimAt: NOW,
    });
    expect(decideToolSync(candidate, NOW)).toEqual({ kind: "skip", reason: "claimed" });
  });

  it("re-admits a connection whose claimant died", () => {
    const candidate = fresh({
      toolsSyncedAt: null,
      toolsSyncClaimId: "sync_abc",
      toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS,
    });
    expect(isSyncEligible(candidate, NOW)).toBe(true);
  });
});

describe("scheduleAfterSuccess", () => {
  it("puts the next attempt one freshness window out", () => {
    expect(scheduleAfterSuccess(NOW, TTL)).toBe(NOW + TTL);
  });

  it("schedules nothing when time-based re-sync is disabled", () => {
    expect(scheduleAfterSuccess(NOW, null)).toBe(null);
  });
});

describe("scheduleAfterFailure", () => {
  const delay = (failures: number, jitter = 1, ttlMs = TTL) =>
    scheduleAfterFailure(NOW, ttlMs, failures, jitter) - NOW;

  it("doubles the wait with every consecutive failure", () => {
    expect(delay(1)).toBe(TTL);
    expect(delay(2)).toBe(2 * TTL);
    expect(delay(3)).toBe(4 * TTL);
    expect(delay(4)).toBe(8 * TTL);
  });

  it("caps the ladder rather than growing without bound", () => {
    // A server dead for a week is still probed a few times a day, which is what
    // makes recovery automatic.
    expect(delay(20)).toBe(TOOL_SYNC_BACKOFF_CEILING_MS);
    expect(delay(1000)).toBe(TOOL_SYNC_BACKOFF_CEILING_MS);
  });

  it("reads a failure count below one as the first failure", () => {
    expect(delay(0)).toBe(TTL);
    expect(delay(-5)).toBe(TTL);
  });

  it("stays within the jitter bounds at every rung", () => {
    for (let failures = 1; failures <= 12; failures += 1) {
      const base = Math.min(TOOL_SYNC_BACKOFF_CEILING_MS, TTL * 2 ** (failures - 1));
      expect(delay(failures, TOOL_SYNC_JITTER_MIN)).toBe(Math.round(base * TOOL_SYNC_JITTER_MIN));
      expect(delay(failures, TOOL_SYNC_JITTER_MAX)).toBe(Math.round(base * TOOL_SYNC_JITTER_MAX));
      for (const jitter of [TOOL_SYNC_JITTER_MIN, 0.93, 1.07, TOOL_SYNC_JITTER_MAX]) {
        const value = delay(failures, jitter);
        expect(value).toBeGreaterThanOrEqual(Math.round(base * TOOL_SYNC_JITTER_MIN));
        expect(value).toBeLessThanOrEqual(Math.round(base * TOOL_SYNC_JITTER_MAX));
      }
    }
  });

  it("returns a whole number of milliseconds for the bigint column", () => {
    expect(Number.isInteger(scheduleAfterFailure(NOW, TTL, 3, 0.8137))).toBe(true);
  });

  it("scales the ladder to whatever base it is given", () => {
    expect(delay(5, 1, 1000)).toBe(16_000);
  });
});
