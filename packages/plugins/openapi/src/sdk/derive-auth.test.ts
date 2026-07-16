import { describe, expect, it } from "@effect/vitest";

import { resolvedOAuthScopes } from "./derive-auth";

describe("resolvedOAuthScopes", () => {
  it("does not synthesize OIDC scopes for a plain OAuth provider", () => {
    expect(resolvedOAuthScopes(["current_user:read", "files:read"], "auto")).toEqual([
      "current_user:read",
      "files:read",
    ]);
  });

  it("preserves advertised OIDC scopes in auto mode", () => {
    expect(resolvedOAuthScopes(["read", "openid", "profile"], "auto")).toEqual([
      "read",
      "openid",
      "profile",
    ]);
  });

  it("merges explicitly configured identity scopes", () => {
    expect(resolvedOAuthScopes(["read", "email"], ["openid", "email"])).toEqual([
      "read",
      "email",
      "openid",
    ]);
  });
});
