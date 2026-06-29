import { describe, expect, it } from "@effect/vitest";

import { isSafeReturnTo, loginPath, safeReturnTo } from "./return-to";

describe("isSafeReturnTo", () => {
  const safe = [
    "/",
    "/tools",
    "/integrations/sentry?addAccount=1",
    "/api-keys",
    "/api/oauth/callback?state=oauth-state&code=provider-code",
  ];
  for (const path of safe) {
    it(`allows ${path}`, () => {
      expect(isSafeReturnTo(path)).toBe(true);
    });
  }

  const unsafe = [
    "https://evil.example",
    "//evil.example",
    "/api/auth/logout",
    "/api/oauth/callback/extra?state=oauth-state",
    "/api",
    "javascript:alert(1)",
    "tools",
    "",
  ];
  for (const path of unsafe) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(isSafeReturnTo(path)).toBe(false);
    });
  }
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
  it("omits returnTo for the root", () => {
    expect(loginPath("/")).toBe("/login");
  });

  it("carries OAuth callback resumes URI-encoded", () => {
    expect(loginPath("/api/oauth/callback?state=oauth-state&code=provider-code")).toBe(
      "/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fstate%3Doauth-state%26code%3Dprovider-code",
    );
  });
});
