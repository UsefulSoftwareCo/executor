import { describe, expect, it } from "@effect/vitest";
import { encodeOAuthCallbackState } from "@executor-js/sdk/shared";
import { oauthAdminVerificationResponse } from "./oauth-admin-verification";

describe("OAuth admin verification recovery", () => {
  it("keeps provider credentials out of the recovery page and preserves session cookies", async () => {
    const state = encodeOAuthCallbackState({ state: "private-state", orgSlug: "example-org" });
    const request = new Request(
      `https://app.example/api/oauth/callback?code=private-code&state=${state}`,
    );
    const denied = Response.json(
      { code: "admin_mfa_required" },
      {
        status: 403,
        headers: { "set-cookie": "wos-session=rotated; Secure; HttpOnly" },
      },
    );
    const response = await oauthAdminVerificationResponse(request, denied);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("wos-session=rotated");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain('href="/example-org/org"');
    expect(body).toContain("Continue connection");
    expect(body).not.toContain("private-code");
    expect(body).not.toContain(state);
    expect(body).not.toContain("<script");
  });

  it("keeps other authorization failures intact", async () => {
    const request = new Request("https://app.example/api/oauth/callback?state=invalid");
    const denied = Response.json({ code: "no_organization" }, { status: 403 });
    expect(await oauthAdminVerificationResponse(request, denied)).toBe(denied);
  });
});
