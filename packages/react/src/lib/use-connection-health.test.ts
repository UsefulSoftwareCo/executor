import { beforeEach, describe, expect, it } from "@effect/vitest";
import type { HealthCheckResult } from "@executor-js/sdk/shared";

import {
  AUTO_PROBE_FLOOR_MS,
  HEALTH_REVALIDATE_MS,
  clearAutomaticProbeMemory,
  recordAutomaticProbe,
  resetAutomaticProbeMemoryForTest,
  revalidateQuery,
  shouldAutoProbe,
} from "./use-connection-health";

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

// shouldAutoProbe consults module-scope memory (see automaticProbeMemory in
// use-connection-health.ts), so every test starts from a clean slate and uses
// a fresh key to avoid cross-test interference even under parallel execution.
describe("shouldAutoProbe", () => {
  beforeEach(() => {
    resetAutomaticProbeMemoryForTest();
  });

  it("probes on first sight, with no persisted verdict and no memory", () => {
    expect(shouldAutoProbe("acme:github:default", null, Date.now())).toBe(true);
  });

  it("does not re-probe a second time inside the floor, even for an expired verdict", () => {
    const key = "acme:github:expired-in-floor";
    const now = Date.now();
    recordAutomaticProbe(key, { status: "expired", checkedAt: now });

    expect(
      shouldAutoProbe(key, verdict("expired"), now + AUTO_PROBE_FLOOR_MS - 1),
      "a remount inside the floor must not re-arm the probe",
    ).toBe(false);
  });

  it("probes again once the floor has elapsed, for a non-healthy verdict", () => {
    const key = "acme:github:expired-after-floor";
    const now = Date.now();
    recordAutomaticProbe(key, { status: "expired", checkedAt: now });

    expect(
      shouldAutoProbe(key, verdict("expired"), now + AUTO_PROBE_FLOOR_MS + 1),
      "the floor elapsing re-arms the probe so recovery can still show",
    ).toBe(true);
  });

  it("suppresses a remembered healthy result younger than HEALTH_REVALIDATE_MS, even past the floor", () => {
    const key = "acme:github:healthy-remembered";
    const now = Date.now();
    recordAutomaticProbe(key, { status: "healthy", checkedAt: now });

    expect(
      shouldAutoProbe(key, null, now + AUTO_PROBE_FLOOR_MS + 1),
      "a fresh healthy verdict must not probe just because the floor elapsed",
    ).toBe(false);
  });

  it("probes again once a remembered healthy result ages past HEALTH_REVALIDATE_MS", () => {
    const key = "acme:github:healthy-stale";
    const now = Date.now();
    recordAutomaticProbe(key, { status: "healthy", checkedAt: now });

    expect(
      shouldAutoProbe(key, null, now + HEALTH_REVALIDATE_MS + 1),
      "a healthy verdict must revalidate once it goes stale",
    ).toBe(true);
  });

  it("re-arms immediately once the entry is cleared, ignoring the floor", () => {
    const key = "acme:github:cleared";
    const now = Date.now();
    recordAutomaticProbe(key, { status: "expired", checkedAt: now });
    expect(shouldAutoProbe(key, verdict("expired"), now + 1), "still inside the floor").toBe(false);

    clearAutomaticProbeMemory(key);

    expect(
      shouldAutoProbe(key, null, now + 1),
      "clearing the memory re-arms the probe even inside the floor",
    ).toBe(true);
  });
});
