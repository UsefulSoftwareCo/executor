import { describe, expect, it } from "@effect/vitest";

import {
  TOOL_SYNC_BACKOFF_CEILING_MS,
  TOOL_SYNC_CLAIM_LEASE_MS,
  TOOL_SYNC_ERROR_KINDS,
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

/** A row every case overrides into the state it is about. Neutral on purpose:
 *  naming it for one of the states under test (it started life as `fresh`)
 *  makes `classifyToolSync(fresh({ toolsSyncedAt: null }))` read as a
 *  contradiction with the assertion beside it. */
const candidate = (overrides: Partial<ToolSyncCandidate> = {}): ToolSyncCandidate => ({
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
  it("narrows exactly the kinds the closed set declares", () => {
    // Pinned as a literal, not derived: the set is closed because
    // `isToolSyncParked`'s auth-only rule and the persisted-column parse depend
    // on it, so a fifth kind has to be a deliberate edit here rather than a
    // silent widening.
    expect([...TOOL_SYNC_ERROR_KINDS]).toEqual(["auth", "unreachable", "protocol", "config"]);
    for (const kind of TOOL_SYNC_ERROR_KINDS) {
      expect(isToolSyncErrorKind(kind)).toBe(true);
    }
  });

  it("rejects anything else a text column could hold", () => {
    for (const value of ["", "AUTH", "authentication", null, undefined, 401, {}]) {
      expect(isToolSyncErrorKind(value)).toBe(false);
    }
  });
});

describe("classifyToolSync", () => {
  it("calls a never-synced, never-marked connection cold", () => {
    expect(classifyToolSync(candidate({ toolsSyncedAt: null }), NOW)).toBe("cold");
  });

  it("calls a connection with a drift mark stale_marked, keeping its stamp", () => {
    expect(
      classifyToolSync(candidate({ toolsSyncedAt: NOW - 60_000, toolsStaleAt: NOW - 1000 }), NOW),
    ).toBe("stale_marked");
  });

  it("still sees a drift mark that landed in the same millisecond as the stamp", () => {
    // Date.now() has millisecond granularity, and a `tools/list_changed`
    // arriving inside the millisecond it invalidates must not be swallowed.
    expect(classifyToolSync(candidate({ toolsSyncedAt: NOW, toolsStaleAt: NOW }), NOW)).toBe(
      "stale_marked",
    );
  });

  it("leaves a drift mark the listing out-dated resolved", () => {
    // An authoritative listing does not clear `tools_stale_at`, it stamps
    // `tools_synced_at` past it. A mark older than the stamp is a settled
    // drift, and the connection must not re-list forever because the column is
    // still set.
    expect(
      classifyToolSync(candidate({ toolsSyncedAt: NOW - 1000, toolsStaleAt: NOW - 2000 }), NOW),
    ).toBe("fresh");
  });

  it("calls a never-synced connection carrying a drift mark stale_marked, not cold", () => {
    expect(classifyToolSync(candidate({ toolsSyncedAt: null, toolsStaleAt: NOW }), NOW)).toBe(
      "stale_marked",
    );
  });

  it("calls a catalog older than its integration's config revision config_revised", () => {
    expect(
      classifyToolSync(
        candidate({ toolsSyncedAt: NOW - 60_000, configRevisedAt: NOW - 30_000 }),
        NOW,
      ),
    ).toBe("config_revised");
  });

  it("still sees a config revision that landed in the same millisecond as the stamp", () => {
    // Same rule as the drift mark, and for a stronger reason: `tools_synced_at`
    // is stamped when the listing STARTED, so a revision inside that
    // millisecond describes a config the listing cannot have read. A plugin
    // without a remote catalog has no TTL backstop to catch it later.
    expect(classifyToolSync(candidate({ toolsSyncedAt: NOW, configRevisedAt: NOW }), NOW)).toBe(
      "config_revised",
    );
  });

  it("leaves a catalog newer than the config revision alone", () => {
    expect(
      classifyToolSync(
        candidate({ toolsSyncedAt: NOW - 30_000, configRevisedAt: NOW - 60_000 }),
        NOW,
      ),
    ).toBe("fresh");
  });

  it("expires a remote catalog on the far side of the TTL only", () => {
    // Both sides of the boundary: flipping the comparison, or shifting the
    // subtraction, changes when every remote catalog re-dials its upstream.
    expect(classifyToolSync(candidate({ toolsSyncedAt: NOW - TTL }), NOW)).toBe("fresh");
    expect(classifyToolSync(candidate({ toolsSyncedAt: NOW - TTL - 1 }), NOW)).toBe("expired");
  });

  it("never expires a catalog the plugin does not list remotely", () => {
    // An OpenAPI catalog is derived from a stored spec: time alone cannot make
    // it wrong, and re-listing it on a timer is pure waste.
    expect(
      classifyToolSync(candidate({ toolsSyncedAt: NOW - TTL - 1, remoteToolCatalog: false }), NOW),
    ).toBe("fresh");
  });

  it("never expires anything when the TTL is disabled", () => {
    expect(classifyToolSync(candidate({ toolsSyncedAt: 0, ttlMs: null }), NOW)).toBe("fresh");
  });

  it("ranks an explicit drift signal above a config revision and the clock", () => {
    expect(
      classifyToolSync(
        candidate({ toolsSyncedAt: NOW - TTL - 1, toolsStaleAt: NOW, configRevisedAt: NOW - 1 }),
        NOW,
      ),
    ).toBe("stale_marked");
  });

  it("ranks a config revision above the clock", () => {
    expect(
      classifyToolSync(candidate({ toolsSyncedAt: NOW - TTL - 1, configRevisedAt: NOW - 1 }), NOW),
    ).toBe("config_revised");
  });
});

describe("isToolSyncClaimLive", () => {
  it("is false with no claim", () => {
    expect(isToolSyncClaimLive(candidate(), NOW)).toBe(false);
  });

  it("is true inside the lease", () => {
    expect(
      isToolSyncClaimLive(
        candidate({
          toolsSyncClaimId: "sync_abc",
          toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS + 1,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false once the lease has run out", () => {
    expect(
      isToolSyncClaimLive(
        candidate({
          toolsSyncClaimId: "sync_abc",
          toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a claim with no timestamp as dead rather than eternal", () => {
    // Otherwise a half-written row would lock a connection out of every future
    // refresh, forever, with nothing to expire it.
    expect(
      isToolSyncClaimLive(candidate({ toolsSyncClaimId: "sync_abc", toolsSyncClaimAt: null }), NOW),
    ).toBe(false);
  });
});

describe("isToolSyncBackedOff", () => {
  it("holds a failing connection off until its retry instant", () => {
    const backedOff = candidate({ toolsSyncFailures: 2, toolsSyncRetryAt: NOW + 1 });
    expect(isToolSyncBackedOff(backedOff, NOW)).toBe(true);
    expect(isToolSyncBackedOff(backedOff, NOW + 1)).toBe(false);
  });

  it("ignores the retry instant a SUCCESS wrote", () => {
    // After a success `tools_sync_retry_at` carries the freshness horizon, not
    // a gate: a drift signal arriving inside the window must heal the catalog
    // immediately instead of waiting the window out.
    const drifted = candidate({
      toolsSyncFailures: 0,
      toolsSyncRetryAt: NOW + TTL,
      toolsStaleAt: NOW,
    });
    expect(isToolSyncBackedOff(drifted, NOW)).toBe(false);
    expect(isSyncEligible(drifted, NOW)).toBe(true);
  });
});

describe("isToolSyncParked", () => {
  it("parks only on an auth verdict", () => {
    expect(isToolSyncParked(candidate({ toolsSyncErrorKind: "auth" }))).toBe(true);
    for (const kind of ["unreachable", "protocol", "config", null] as const) {
      expect(isToolSyncParked(candidate({ toolsSyncErrorKind: kind }))).toBe(false);
    }
  });
});

describe("decideToolSync", () => {
  it("passes a due connection with a clear ledger, reporting what made it due", () => {
    expect(decideToolSync(candidate({ toolsSyncedAt: null }), NOW)).toEqual({
      kind: "refresh",
      trigger: "cold",
    });
  });

  it("skips a fresh connection", () => {
    expect(decideToolSync(candidate(), NOW)).toEqual({ kind: "skip", reason: "fresh" });
  });

  it("skips a parked connection however overdue the clock says it is", () => {
    expect(
      decideToolSync(
        candidate({
          toolsSyncedAt: null,
          toolsSyncFailures: 9,
          toolsSyncErrorKind: "auth",
          toolsSyncRetryAt: NOW - 1,
        }),
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: "parked" });
  });

  it("skips a connection inside its backoff window", () => {
    expect(
      decideToolSync(
        candidate({
          toolsSyncedAt: null,
          toolsSyncFailures: 1,
          toolsSyncErrorKind: "unreachable",
          toolsSyncRetryAt: NOW + 1,
        }),
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: "backoff" });
  });

  it("skips a connection another attempt is already holding", () => {
    expect(
      decideToolSync(
        candidate({ toolsSyncedAt: null, toolsSyncClaimId: "sync_abc", toolsSyncClaimAt: NOW }),
        NOW,
      ),
    ).toEqual({ kind: "skip", reason: "claimed" });
  });

  it("re-admits a connection whose claimant died", () => {
    expect(
      decideToolSync(
        candidate({
          toolsSyncedAt: null,
          toolsSyncClaimId: "sync_abc",
          toolsSyncClaimAt: NOW - TOOL_SYNC_CLAIM_LEASE_MS,
        }),
        NOW,
      ),
    ).toEqual({ kind: "refresh", trigger: "cold" });
  });

  // The skip reason is not cosmetic: the read fans it into three separate
  // operator counters, so a clause reordering silently misattributes every sync
  // skip. Each case below satisfies SEVERAL clauses at once, which is the only
  // way the order itself is what the assertion pins.
  describe("precedence", () => {
    it("reports fresh over an auth verdict left on the row", () => {
      // A parked connection that has since been re-listed is FRESH. Ranking the
      // park first would count every healthy connection carrying a stale error
      // kind as parked, on every read.
      expect(decideToolSync(candidate({ toolsSyncErrorKind: "auth" }), NOW)).toEqual({
        kind: "skip",
        reason: "fresh",
      });
    });

    it("reports parked over a backoff window that is still open", () => {
      expect(
        decideToolSync(
          candidate({
            toolsSyncedAt: null,
            toolsSyncErrorKind: "auth",
            toolsSyncFailures: 3,
            toolsSyncRetryAt: NOW + TTL,
          }),
          NOW,
        ),
      ).toEqual({ kind: "skip", reason: "parked" });
    });

    it("reports backoff over a live claim", () => {
      expect(
        decideToolSync(
          candidate({
            toolsSyncedAt: null,
            toolsSyncFailures: 2,
            toolsSyncRetryAt: NOW + 1,
            toolsSyncClaimId: "sync_abc",
            toolsSyncClaimAt: NOW,
          }),
          NOW,
        ),
      ).toEqual({ kind: "skip", reason: "backoff" });
    });
  });

  // The park answers "the clock alone is not a reason to re-dial a rejected
  // credential". It is not an answer to somebody telling us the world changed.
  describe("park yields to an explicit invalidation", () => {
    it("refreshes a parked connection whose integration config was revised", () => {
      // This is the repair path: an `auth` verdict caused by integration
      // configuration is fixed by editing that configuration, and
      // `integrations.update` is the one invalidation that does not clear the
      // ladder. Swallowing it leaves the fixed connection parked forever.
      expect(
        decideToolSync(
          candidate({
            toolsSyncedAt: NOW - 60_000,
            configRevisedAt: NOW - 1,
            toolsSyncErrorKind: "auth",
          }),
          NOW,
        ),
      ).toEqual({ kind: "refresh", trigger: "config_revised" });
    });

    it("refreshes a parked connection that was marked stale", () => {
      expect(
        decideToolSync(
          candidate({ toolsSyncedAt: NOW - 60_000, toolsStaleAt: NOW, toolsSyncErrorKind: "auth" }),
          NOW,
        ),
      ).toEqual({ kind: "refresh", trigger: "stale_marked" });
    });

    it("still parks when only the clock is asking", () => {
      for (const overrides of [
        { toolsSyncedAt: null },
        { toolsSyncedAt: NOW - TTL - 1 },
      ] as const) {
        expect(
          decideToolSync(candidate({ ...overrides, toolsSyncErrorKind: "auth" }), NOW),
        ).toEqual({ kind: "skip", reason: "parked" });
      }
    });
  });
});

describe("isSyncEligible", () => {
  it("projects the decision to a boolean", () => {
    expect(isSyncEligible(candidate({ toolsSyncedAt: null }), NOW)).toBe(true);
    expect(isSyncEligible(candidate(), NOW)).toBe(false);
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
    // `failures` is the count INCLUDING the failure being recorded, so 1 is the
    // first rung. Out-of-contract counts are not clamped — a caller passing the
    // prior count would run the whole ladder one step short, and that is a bug
    // to surface rather than launder.
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
