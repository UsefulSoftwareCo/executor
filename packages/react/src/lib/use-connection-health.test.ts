import { describe, expect, it } from "@effect/vitest";
import type { HealthCheckResult } from "@executor-js/sdk/shared";

import { HEALTH_REVALIDATE_MS, presentableHealth, revalidateQuery } from "./use-connection-health";

const verdict = (status: HealthCheckResult["status"]): HealthCheckResult => ({
  status,
  checkedAt: Date.now(),
});

describe("revalidateQuery", () => {
  it("defers a healthy verdict to the server-enforced freshness window", () => {
    expect(revalidateQuery(verdict("healthy")).ifStaleMs, "the healthy window is sent").toBe(
      HEALTH_REVALIDATE_MS,
    );
  });

  // The load-bearing case, and the reason this cannot become a short window.
  // Every non-healthy verdict is PERSISTED, so a request carrying `ifStaleMs`
  // would be answered from the row the previous probe wrote — "still expired" —
  // and the dot could not turn green until the window elapsed. Omitting the
  // window is what makes recovery show on the next load.
  it.each(["expired", "degraded", "unknown"] as const)(
    "forces a fresh probe for a %s verdict, so recovery shows on the next load",
    (status) => {
      expect(
        revalidateQuery(verdict(status)).ifStaleMs,
        "a non-healthy verdict must not be answered from the persisted verdict",
      ).toBeUndefined();
    },
  );

  it("forces a fresh probe for a never-checked connection too", () => {
    expect(revalidateQuery(null).ifStaleMs, "a cleared verdict probes").toBeUndefined();
    expect(revalidateQuery(undefined).ifStaleMs, "a never-seen one probes").toBeUndefined();
  });

  // An OAuth re-mint clears the persisted verdict, and the hook re-arms on that
  // clearing transition. If the resulting request carried a window it could be
  // answered from a verdict a pre-reconnect probe raced in afterwards, and the
  // reconnected row would keep reading Expired.
  it("never sends a window for anything but a healthy verdict", () => {
    const windows = (["expired", "degraded", "unknown"] as const).map(
      (status) => revalidateQuery(verdict(status)).ifStaleMs,
    );
    expect(windows, "only the healthy path is gated").toEqual([undefined, undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------
// Tool-sync stamps are not connection health. `toolSyncHealth` writes a
// degraded verdict with the "Tool sync failing" detail prefix into
// `last_health` when catalog production fails; presenting that as the
// connection's health painted whole integration rows "Degraded" (one bad
// sweep stamps many connections at once) for credentials that were fine.
// ---------------------------------------------------------------------------

describe("presentableHealth", () => {
  it("passes genuine probe verdicts through untouched", () => {
    const expired: HealthCheckResult = {
      status: "expired",
      checkedAt: Date.now(),
      detail: "HTTP 401",
    };
    expect(presentableHealth(expired), "a probe verdict presents as-is").toBe(expired);
  });

  it("hides a tool-sync stamp, old (detail-only) and new (reason) alike", () => {
    const stamped: HealthCheckResult = {
      status: "degraded",
      checkedAt: Date.now(),
      detail: "Tool sync failing: upstream returned HTTP 429",
      reason: "tool_sync_failed",
    };
    // Stamps written before `reason` existed carry only the detail prefix.
    const legacy: HealthCheckResult = {
      status: "degraded",
      checkedAt: Date.now(),
      detail: "Tool sync failing: plugin returned an incomplete tool catalog",
    };
    expect(presentableHealth(stamped), "a sync stamp is not connection health").toBeNull();
    expect(presentableHealth(legacy), "pre-reason stamps hide the same way").toBeNull();
  });

  it("treats missing verdicts as missing", () => {
    expect(presentableHealth(null)).toBeNull();
    expect(presentableHealth(undefined)).toBeNull();
  });

  it("does not hide a probe verdict whose upstream text merely mentions syncing", () => {
    // The marker is the detail PREFIX, owned by the sync stamp writer — an
    // upstream error that contains similar words elsewhere stays visible.
    const probeVerdict: HealthCheckResult = {
      status: "degraded",
      checkedAt: Date.now(),
      detail: "Health check request failed: upstream sync service unavailable",
    };
    expect(presentableHealth(probeVerdict)).toBe(probeVerdict);
  });
});
