import { describe, expect, it } from "@effect/vitest";
import type { HealthCheckResult } from "@executor-js/sdk/shared";

import {
  HEALTH_REVALIDATE_MS,
  HEALTH_REVALIDATE_UNHEALTHY_MS,
  revalidateQuery,
} from "./use-connection-health";

const verdict = (status: HealthCheckResult["status"]): HealthCheckResult => ({
  status,
  checkedAt: Date.now(),
});

describe("revalidateQuery", () => {
  it("defers a healthy verdict to the long freshness window", () => {
    expect(revalidateQuery(verdict("healthy")).ifStaleMs, "the healthy window is sent").toBe(
      HEALTH_REVALIDATE_MS,
    );
  });

  // The load-bearing case. A connection whose credential is broken is exactly
  // the connection every mount wants to re-probe, and each probe is a fresh
  // request to an upstream that is already refusing. Sending a SHORT window
  // instead of none keeps recovery visible while letting the server's
  // freshness gate collapse repeated mounts and concurrent tabs into one probe.
  it.each(["expired", "degraded", "unknown"] as const)(
    "still sends a short window for a %s verdict, so repeated mounts cannot stampede the upstream",
    (status) => {
      const window = revalidateQuery(verdict(status)).ifStaleMs;
      expect(
        window,
        "a non-healthy verdict sends a freshness window, not an unconditional probe",
      ).toBeGreaterThan(0);
      expect(window, "and it is the short non-healthy window").toBe(HEALTH_REVALIDATE_UNHEALTHY_MS);
    },
  );

  it("sends the short window for a never-checked connection too", () => {
    // Nothing is persisted, so the server has no cached verdict to serve and
    // probes regardless — but a second surface mounting moments later is
    // covered by the verdict the first one just wrote.
    expect(
      revalidateQuery(null).ifStaleMs,
      "a missing verdict still sends a window",
    ).toBeGreaterThan(0);
    expect(revalidateQuery(null).ifStaleMs, "and it is the short one").toBe(
      HEALTH_REVALIDATE_UNHEALTHY_MS,
    );
    expect(revalidateQuery(undefined).ifStaleMs, "a never-seen one behaves the same").toBe(
      HEALTH_REVALIDATE_UNHEALTHY_MS,
    );
  });

  it("keeps the unhealthy window far shorter than the healthy one, so recovery still shows up", () => {
    expect(HEALTH_REVALIDATE_UNHEALTHY_MS).toBeGreaterThan(0);
    expect(HEALTH_REVALIDATE_UNHEALTHY_MS).toBeLessThan(HEALTH_REVALIDATE_MS);
  });
});
