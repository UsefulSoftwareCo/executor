import { describe, expect, it } from "@effect/vitest";

import { isSafeReturnTo, loginPath, safeReturnTo } from "./return-to";

// Guards the login round-trip channel (SSR gate → /login → /api/auth/login →
// OAuth state param → callback redirect). Everything here crosses a trust
// boundary, so the validator is what stands between "resume where you were"
// and an open redirect.
describe("isSafeReturnTo", () => {
  const safe = [
    "/",
    "/tools",
    "/integrations/sentry?addAccount=1",
    "/billing/plans",
    "/api/oauth/callback?state=oauth-state&code=provider-code",
  ];
  for (const path of safe) {
    it(`allows ${path}`, () => {
      expect(isSafeReturnTo(path)).toBe(true);
    });
  }

  const unsafe = [
    "https://evil.example", // absolute URL — off-origin redirect
    "//evil.example", // protocol-relative — same thing in disguise
    "/api/auth/logout", // API endpoints are never a landing page
    "/api/oauth/callback/extra?state=oauth-state", // only the exact OAuth callback resumes
    "/api", // bare /api too
    "javascript:alert(1)", // not a path at all
    "tools", // relative paths resolve unpredictably
    "", // empty
  ];
  for (const path of unsafe) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(isSafeReturnTo(path)).toBe(false);
    });
  }

  // /api-keys is a React page, not an API path — the prefix check must not
  // swallow it.
  it("allows /api-keys (page, not API)", () => {
    expect(isSafeReturnTo("/api-keys")).toBe(true);
  });
});

describe("safeReturnTo", () => {
  it("passes a safe path through", () => {
    expect(safeReturnTo("/tools")).toBe("/tools");
  });
  it("nulls unsafe and absent values", () => {
    expect(safeReturnTo("https://evil.example")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });
});

describe("loginPath", () => {
  it("omits returnTo for the root (the default destination)", () => {
    expect(loginPath("/")).toBe("/login");
  });
  it("carries deep links URI-encoded", () => {
    expect(loginPath("/integrations/sentry?addAccount=1")).toBe(
      "/login?returnTo=%2Fintegrations%2Fsentry%3FaddAccount%3D1",
    );
  });
  it("carries OAuth callback resumes URI-encoded", () => {
    expect(loginPath("/api/oauth/callback?state=oauth-state&code=provider-code")).toBe(
      "/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fstate%3Doauth-state%26code%3Dprovider-code",
    );
  });
});
