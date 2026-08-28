import { describe, expect, it } from "@effect/vitest";
import type { HealthCheckResult } from "@executor-js/sdk/shared";

import { HEALTH_REVALIDATE_MS, revalidateQuery } from "./use-connection-health";

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
