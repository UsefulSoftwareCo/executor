import { describe, expect, it } from "@effect/vitest";

import { decodeLoginState, encodeLoginState } from "./login-state";

// The OAuth state parameter carries { nonce, returnTo } through the WorkOS
// round trip. It crosses a trust boundary twice (authorize URL out, callback
// query in), so decoding must be total — junk reads as null, never a throw.
describe("login state codec", () => {
  it("round-trips nonce + returnTo", () => {
    const state = { nonce: "a".repeat(64), returnTo: "/integrations/sentry?addAccount=1" };
    expect(decodeLoginState(encodeLoginState(state))).toEqual(state);
  });

  it("round-trips a state without returnTo", () => {
    const state = { nonce: "b".repeat(64) };
    expect(decodeLoginState(encodeLoginState(state))).toEqual(state);
  });

  it("is URL-safe verbatim (no characters that need query escaping)", () => {
    const encoded = encodeLoginState({ nonce: "c".repeat(64), returnTo: "/tools?q=a b&x=+/" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // The callback can be reached by WorkOS-initiated redirects whose state we
  // never minted, and by anyone typing a URL.
  const junk = [
    null,
    undefined,
    "", // absent
    "not-base64url!!", // invalid alphabet
    "aGVsbG8", // valid base64url, not JSON ("hello")
    "eyJmb28iOiJiYXIifQ", // valid JSON, wrong shape ({"foo":"bar"})
  ];
  for (const value of junk) {
    it(`reads ${JSON.stringify(value)} as null`, () => {
      expect(decodeLoginState(value)).toBeNull();
    });
  }
});
