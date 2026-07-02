import { describe, expect, it } from "@effect/vitest";

import { isSafeReturnTo, loginPath, mcpAuthorizeResumeTarget, safeReturnTo } from "./return-to";

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

describe("mcpAuthorizeResumeTarget", () => {
  // Better Auth bounces an unauthenticated MCP authorize to /login carrying the
  // OAuth params; after sign-in we resume by handing them back to the authorize
  // endpoint so it issues a code (then the consent shim takes over).
  it("rebuilds the authorize URL from a real MCP authorize redirect", () => {
    const search =
      "?response_type=code&client_id=abc&code_challenge=xyz&code_challenge_method=S256" +
      "&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&state=s1&scope=openid+profile&prompt=consent";
    const target = mcpAuthorizeResumeTarget(search);
    expect(target).not.toBeNull();
    expect(target!.startsWith("/api/auth/mcp/authorize?")).toBe(true);
    const params = new URLSearchParams(target!.split("?")[1]);
    expect(params.get("client_id")).toBe("abc");
    expect(params.get("redirect_uri")).toBe("http://localhost:3118/callback");
    expect(params.get("response_type")).toBe("code");
  });

  it("ignores searches that are not an authorize request", () => {
    expect(mcpAuthorizeResumeTarget("")).toBeNull();
    expect(mcpAuthorizeResumeTarget("?returnTo=%2Ftools")).toBeNull();
    // response_type alone is not enough: client_id and redirect_uri are required.
    expect(mcpAuthorizeResumeTarget("?response_type=code&client_id=abc")).toBeNull();
    expect(
      mcpAuthorizeResumeTarget("?response_type=token&client_id=abc&redirect_uri=x"),
    ).toBeNull();
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
