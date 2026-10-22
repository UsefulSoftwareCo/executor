import { describe, expect, it } from "@effect/vitest";
import { MAX_DELEGATION_TTL_MS } from "@executor-js/sdk";

import { parseDelegatedMaxTtlMs } from "./config";

describe("self-host delegated credential configuration", () => {
  it("uses the SDK maximum by default and accepts a lower cap", () => {
    expect(parseDelegatedMaxTtlMs(undefined)).toBe(MAX_DELEGATION_TTL_MS);
    expect(parseDelegatedMaxTtlMs("604800000")).toBe(604800000);
  });

  it.each(["0", "-1", "not-a-number", String(MAX_DELEGATION_TTL_MS + 1)])(
    "rejects an invalid operator cap: %s",
    (raw) => {
      expect(() => parseDelegatedMaxTtlMs(raw)).toThrowError("EXECUTOR_DELEGATED_MAX_TTL_MS");
    },
  );
});
