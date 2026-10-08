import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { isAdmitted, ssoProviderConfig } from "./sso";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ssoProviderConfig", () => {
  // A stock Okta tenant issues an ID token with `email` but no
  // `email_verified`; the claim is only served from UserInfo (#1972). The
  // Okta emulator always signs `email_verified` into its ID tokens, so the two
  // IdP responses are stubbed here.
  it("reads email_verified from UserInfo when the ID token omits it", async () => {
    const sso = {
      providerId: "okta",
      providerName: "Okta",
      discoveryUrl: "https://idp.example/.well-known/openid-configuration",
      clientId: "client-id",
      clientSecret: "client-secret",
      allowedDomains: ["example.com"],
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === sso.discoveryUrl) {
        return Response.json({ userinfo_endpoint: "https://idp.example/userinfo" });
      }
      return new Headers(init?.headers).get("authorization") === "Bearer access-token"
        ? Response.json({ sub: "alice", email: "alice@example.com", email_verified: true })
        : new Response(null, { status: 401 });
    });
    const claims = { sub: "alice", email: "alice@example.com" };
    const idToken = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

    const user = await ssoProviderConfig(sso).getUserInfo({ idToken, accessToken: "access-token" });

    expect(user).toMatchObject({ id: "alice", email: "alice@example.com", emailVerified: true });
    expect(isAdmitted(sso, user!)).toBe(true);
  });
});
