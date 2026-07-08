import { describe, expect, it } from "@effect/vitest";

import { isToolsSyncStale, TOOLS_SYNC_STALE_THRESHOLD } from "./tools-sync";

describe("isToolsSyncStale", () => {
  it("no record (last sync authoritative) is not stale", () => {
    expect(isToolsSyncStale(null)).toBe(false);
    expect(isToolsSyncStale(undefined)).toBe(false);
  });

  it("a below-threshold streak is a blip, not staleness", () => {
    expect(isToolsSyncStale({ at: 1, failures: 1, reason: "server down" })).toBe(false);
    expect(
      isToolsSyncStale({ at: 1, failures: TOOLS_SYNC_STALE_THRESHOLD - 1, reason: "server down" }),
    ).toBe(false);
  });

  it("a streak at or past the threshold is stale", () => {
    expect(
      isToolsSyncStale({ at: 1, failures: TOOLS_SYNC_STALE_THRESHOLD, reason: "server down" }),
    ).toBe(true);
    expect(
      isToolsSyncStale({
        at: 1,
        failures: TOOLS_SYNC_STALE_THRESHOLD + 5,
        reason: "server down",
      }),
    ).toBe(true);
  });
});
