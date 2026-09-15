import { afterEach, expect, test, vi } from "@effect/vitest";

import { ssoProviderConfig } from "./sso";

const sso = {
  providerId: "okta",
  providerName: "Okta",
  discoveryUrl: "https://idp.example/.well-known/openid-configuration",
  clientId: "client-id",
  clientSecret: "client-secret",
  allowedDomains: ["example.com"],
};

const jwt = (claims: object): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

afterEach(() => vi.unstubAllGlobals());

const withFetch = async (
  responses: Array<{ readonly ok: boolean; readonly body: object }>,
  run: () => Promise<void>,
) => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      return new Response(JSON.stringify(response?.body ?? {}), {
        status: response?.ok ? 200 : 500,
      });
    }),
  );
  await run();
  return requests;
};

test("falls back to UserInfo when a thin ID token omits email_verified", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      {
        ok: true,
        body: { sub: "alice", email: "alice@example.com", email_verified: true, name: "Alice" },
      },
    ],
    async () => {
      await expect(
        getUserInfo({
          idToken: jwt({ sub: "alice", email: "alice@example.com" }),
          accessToken: "access-token",
        }),
      ).resolves.toMatchObject({ id: "alice", email: "alice@example.com", emailVerified: true });
    },
  );

  expect(requests.map((request) => request.url)).toEqual([
    "https://idp.example/.well-known/openid-configuration",
    "https://idp.example/userinfo",
  ]);
  expect(requests[1]!.headers.get("authorization")).toBe("Bearer access-token");
});

test("does not admit an unverified UserInfo email", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "alice", email: "alice@example.com" } },
    ],
    async () => {
      await expect(
        getUserInfo({
          idToken: jwt({ sub: "alice", email: "alice@example.com" }),
          accessToken: "access-token",
        }),
      ).resolves.toMatchObject({ emailVerified: false });
    },
  );
});

test("does not let camel-case claims override email_verified", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  await expect(
    getUserInfo({
      idToken: jwt({
        sub: "alice",
        email: "alice@example.com",
        email_verified: false,
        emailVerified: true,
      }),
      accessToken: "access-token",
    }),
  ).resolves.toMatchObject({ emailVerified: false });

  await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      {
        ok: true,
        body: {
          sub: "alice",
          email: "alice@example.com",
          email_verified: false,
          emailVerified: true,
        },
      },
    ],
    async () => {
      await expect(
        getUserInfo({
          idToken: jwt({ sub: "alice", email: "alice@example.com" }),
          accessToken: "access-token",
        }),
      ).resolves.toMatchObject({ emailVerified: false });
    },
  );
});

test("keeps the existing provider discovery and scopes (control)", () => {
  const config = ssoProviderConfig(sso);
  expect(config).toMatchObject({
    providerId: "okta",
    discoveryUrl: "https://idp.example/.well-known/openid-configuration",
    scopes: ["openid", "email", "profile"],
    pkce: true,
  });
});
