import { describe, expect, it } from "@effect/vitest";

import { decodeOAuthCallbackState, encodeOAuthCallbackState } from "./oauth";

describe("OAuth callback state", () => {
  it("keeps state raw when no URL org slug is present", () => {
    expect(encodeOAuthCallbackState({ state: "state_123", orgSlug: null })).toBe("state_123");
    expect(decodeOAuthCallbackState("state_123")).toBeNull();
  });

  it("round-trips the raw session state and URL org slug", () => {
    const encoded = encodeOAuthCallbackState({ state: "state_123", orgSlug: " acme " });

    expect(encoded).not.toBe("state_123");
    expect(decodeOAuthCallbackState(encoded)).toEqual({
      state: "state_123",
      orgSlug: "acme",
    });
  });

  it("rejects foreign state values", () => {
    expect(decodeOAuthCallbackState("not-base64url!!")).toBeNull();
    expect(decodeOAuthCallbackState("aGVsbG8")).toBeNull();
  });
});
