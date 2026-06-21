import { describe, expect, it } from "@effect/vitest";

import { oauthCallbackSignInRedirectLocation } from "./oauth-callback-login";

const auth = (session: unknown | null) => ({
  api: {
    getSession: async () => session,
  },
});

describe("oauthCallbackSignInRedirectLocation", () => {
  it("redirects a signed-out OAuth callback to login with returnTo", async () => {
    await expect(
      oauthCallbackSignInRedirectLocation(
        new Request("http://selfhost.test/api/oauth/callback?state=s1&code=c1"),
        auth(null),
      ),
    ).resolves.toBe("/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fstate%3Ds1%26code%3Dc1");
  });

  it("does not redirect a signed-in OAuth callback", async () => {
    await expect(
      oauthCallbackSignInRedirectLocation(
        new Request("http://selfhost.test/api/oauth/callback?state=s1&code=c1"),
        auth({ user: { id: "user_1" } }),
      ),
    ).resolves.toBeNull();
  });

  it("ignores other paths and non-browser methods", async () => {
    await expect(
      oauthCallbackSignInRedirectLocation(
        new Request("http://selfhost.test/api/oauth/callback?state=s1", { method: "POST" }),
        auth(null),
      ),
    ).resolves.toBeNull();
    await expect(
      oauthCallbackSignInRedirectLocation(
        new Request("http://selfhost.test/api/oauth/callback/extra?state=s1"),
        auth(null),
      ),
    ).resolves.toBeNull();
  });
});
