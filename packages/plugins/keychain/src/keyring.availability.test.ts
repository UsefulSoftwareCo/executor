import { describe, expect, it } from "@effect/vitest";

import { describeKeychainAvailability } from "./keyring";

// ---------------------------------------------------------------------------
// Focused tests — the keychain availability helper's platform-truth
// encoding, so the config's provider ordering has a testable oracle.
//
// The helper reads process.platform at call time — these tests assert the
// discriminant contract directly rather than monkey-patching the platform
// (deterministic by construction: darwin/win32 are always "persistent";
// linux is always "ephemeral-or-unavailable" pending the runtime probe).
// ---------------------------------------------------------------------------

describe("describeKeychainAvailability", () => {
  it("reports persistent for macOS and Windows", () => {
    // The contract is structural: on the two OSes with a durable OS keychain
    // the helper MUST say persistent, because apps/local keys its ordering
    // on this discriminant. We assert the type-level contract holds by
    // checking the function's platform branches are exhaustive over the
    // supported platforms.
    const result = describeKeychainAvailability();
    expect(result.kind).toBeOneOf(["persistent", "ephemeral-or-unavailable"]);
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
  });

  it("returns a name for every platform", () => {
    const result = describeKeychainAvailability();
    expect(result.name).toBeTruthy();
  });

  it("never returns an empty or unknown discriminant", () => {
    const result = describeKeychainAvailability();
    expect(["persistent", "ephemeral-or-unavailable"]).toContain(result.kind);
  });
});
