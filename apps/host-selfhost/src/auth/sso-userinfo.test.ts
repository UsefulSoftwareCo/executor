import { afterEach, expect, test, vi } from "@effect/vitest";

import { isAdmitted, ssoProviderConfig } from "./sso";

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

// `email_verified: false` is falsy but present: the ID token is complete and
// must be honoured as-is, never "topped up" by a second opinion from UserInfo.
test("honours an explicit email_verified: false without consulting UserInfo", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch([], async () => {
    await expect(
      getUserInfo({
        idToken: jwt({ sub: "alice", email: "alice@example.com", email_verified: false }),
        accessToken: "access-token",
      }),
    ).resolves.toMatchObject({ id: "alice", email: "alice@example.com", emailVerified: false });
  });

  expect(requests).toEqual([]);
});

test("maps name and picture from a complete ID token", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch([], async () => {
    await expect(
      getUserInfo({
        idToken: jwt({
          sub: "alice",
          email: "alice@example.com",
          email_verified: true,
          name: "Alice",
          picture: "https://idp.example/alice.png",
        }),
        accessToken: "access-token",
      }),
    ).resolves.toMatchObject({
      id: "alice",
      emailVerified: true,
      name: "Alice",
      image: "https://idp.example/alice.png",
    });
  });

  expect(requests).toEqual([]);
});

test("falls back to UserInfo when the ID token payload is malformed", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "alice", email: "alice@example.com", email_verified: true } },
    ],
    async () => {
      await expect(
        getUserInfo({ idToken: "header.!!not-json!!.signature", accessToken: "access-token" }),
      ).resolves.toMatchObject({ id: "alice", emailVerified: true });
    },
  );

  expect(requests).toHaveLength(2);
});

test("returns null for a thin ID token with no access token to spend", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch([], async () => {
    await expect(
      getUserInfo({ idToken: jwt({ sub: "alice", email: "alice@example.com" }) }),
    ).resolves.toBeNull();
  });

  expect(requests).toEqual([]);
});

test("returns null when discovery fails or omits userinfo_endpoint", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };

  await withFetch([{ ok: false, body: {} }], async () => {
    await expect(getUserInfo(tokens)).resolves.toBeNull();
  });

  const requests = await withFetch(
    [{ ok: true, body: { issuer: "https://idp.example" } }],
    async () => {
      await expect(getUserInfo(tokens)).resolves.toBeNull();
    },
  );
  expect(requests).toHaveLength(1);
});

test("returns null when UserInfo fails or omits sub or email", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };

  for (const profile of [
    { ok: false, body: {} },
    { ok: true, body: { email: "alice@example.com", email_verified: true } },
    { ok: true, body: { sub: "alice", email_verified: true } },
  ]) {
    await withFetch([discovery, profile], async () => {
      await expect(getUserInfo(tokens)).resolves.toBeNull();
    });
  }
});

// Network and decoding failures at either external boundary must decline the
// profile like a non-OK response, rather than reject the OAuth callback.
test("returns null when UserInfo fetch or JSON parsing rejects", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };
  const discovery = new Response(
    JSON.stringify({ userinfo_endpoint: "https://idp.example/userinfo" }),
  );
  // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test-only mock of a third-party response JSON boundary
  const invalidJson = { ok: true, json: () => Promise.reject(new Error("invalid JSON")) };
  // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test-only mock of an unavailable third-party request boundary
  const offline = () => Promise.reject(new Error("offline"));

  for (const responses of [
    [offline()],
    [invalidJson],
    [discovery, offline()],
    [discovery, invalidJson],
  ]) {
    const fetch = vi.fn();
    for (const response of responses) fetch.mockImplementationOnce(() => response);
    vi.stubGlobal("fetch", fetch);
    await expect(getUserInfo(tokens)).resolves.toBeNull();
    vi.unstubAllGlobals();
  }
});

// The claim is only worth resolving because the admission gate reads it: a thin
// token that used to arrive without `email_verified` was refused at the door.
test("resolves a thin ID token into an admitted user at the gate", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "alice", email: "alice@example.com", email_verified: true } },
    ],
    async () => {
      const user = await getUserInfo({
        idToken: jwt({ sub: "alice", email: "alice@example.com" }),
        accessToken: "access-token",
      });
      expect(
        isAdmitted(sso, { email: user!.email, emailVerified: user!.emailVerified === true }),
      ).toBe(true);
    },
  );

  await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "mallory", email: "mallory@example.com" } },
    ],
    async () => {
      const user = await getUserInfo({
        idToken: jwt({ sub: "mallory", email: "mallory@example.com" }),
        accessToken: "access-token",
      });
      expect(
        isAdmitted(sso, { email: user!.email, emailVerified: user!.emailVerified === true }),
      ).toBe(false);
    },
  );
});

test("registers the UserInfo resolver for the Google provider path too", () => {
  const config = ssoProviderConfig({ ...sso, providerId: "google" });
  expect(typeof config.getUserInfo).toBe("function");
  expect(config).toMatchObject({ authorizationUrlParams: { hd: "example.com" } });
});

test("resolves through UserInfo when the callback carries no ID token at all", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "alice", email: "alice@example.com", email_verified: true } },
    ],
    async () => {
      await expect(getUserInfo({ accessToken: "access-token" })).resolves.toMatchObject({
        id: "alice",
        emailVerified: true,
      });
    },
  );

  expect(requests).toHaveLength(2);
});

// A JWT with no payload segment at all, as distinct from a payload that is not
// JSON: both must degrade to the UserInfo lookup rather than throw.
test("falls back to UserInfo when the ID token has no payload segment", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };
  const profile = {
    ok: true,
    body: { sub: "alice", email: "alice@example.com", email_verified: true },
  };

  for (const idToken of ["", "no-periods-at-all", "header..signature"]) {
    const requests = await withFetch([discovery, profile], async () => {
      await expect(getUserInfo({ idToken, accessToken: "access-token" })).resolves.toMatchObject({
        id: "alice",
        emailVerified: true,
      });
    });
    expect(requests).toHaveLength(2);
  }
});

// `sub` alone is not enough to skip UserInfo, and an empty-string email is
// falsy-but-present — it must not be accepted as the address to admit.
test("falls back to UserInfo when the ID token omits or empties email", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };
  const profile = {
    ok: true,
    body: { sub: "alice", email: "alice@example.com", email_verified: true },
  };

  for (const claims of [
    { sub: "alice", email_verified: true },
    { sub: "alice", email: "", email_verified: true },
    { email: "alice@example.com", email_verified: true },
  ]) {
    const requests = await withFetch([discovery, profile], async () => {
      await expect(
        getUserInfo({ idToken: jwt(claims), accessToken: "access-token" }),
      ).resolves.toMatchObject({ id: "alice", email: "alice@example.com", emailVerified: true });
    });
    expect(requests).toHaveLength(2);
  }
});

// A `null` claim is present-but-not-a-positive-assertion. It short-circuits the
// UserInfo lookup (it is not `undefined`), so the gate is what must refuse it.
test("never admits a null email_verified from either claim source", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;

  const requests = await withFetch([], async () => {
    const user = await getUserInfo({
      idToken: jwt({ sub: "alice", email: "alice@example.com", email_verified: null }),
      accessToken: "access-token",
    });
    expect(user).toMatchObject({ id: "alice", emailVerified: null });
    expect(
      isAdmitted(sso, { email: user!.email, emailVerified: user!.emailVerified === true }),
    ).toBe(false);
  });
  expect(requests).toEqual([]);

  await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "alice", email: "alice@example.com", email_verified: null } },
    ],
    async () => {
      const user = await getUserInfo({
        idToken: jwt({ sub: "alice", email: "alice@example.com" }),
        accessToken: "access-token",
      });
      expect(user).toMatchObject({ emailVerified: false });
      expect(
        isAdmitted(sso, { email: user!.email, emailVerified: user!.emailVerified === true }),
      ).toBe(false);
    },
  );
});

// Both guards on the ID-token shortcut are truthiness checks, so a claim that
// is present but empty must not be mistaken for a supplied one: `sub: ""` has
// to reach UserInfo, and an empty access token is no token to spend.
test("treats empty-string sub and access token as absent, not supplied", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };
  const profile = {
    ok: true,
    body: { sub: "alice", email: "alice@example.com", email_verified: true },
  };

  const resolved = await withFetch([discovery, profile], async () => {
    await expect(
      getUserInfo({
        idToken: jwt({ sub: "", email: "alice@example.com", email_verified: true }),
        accessToken: "access-token",
      }),
    ).resolves.toMatchObject({ id: "alice", emailVerified: true });
  });
  expect(resolved).toHaveLength(2);

  const skipped = await withFetch([], async () => {
    await expect(
      getUserInfo({
        idToken: jwt({ sub: "alice", email: "alice@example.com" }),
        accessToken: "",
      }),
    ).resolves.toBeNull();
  });
  expect(skipped).toEqual([]);
});

// The same falsy-but-present case on the responses: an empty endpoint must not
// be fetched, and an empty `sub` or `email` from UserInfo is not an identity.
test("rejects empty-string userinfo_endpoint, sub and email from the IdP", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };

  const stopped = await withFetch([{ ok: true, body: { userinfo_endpoint: "" } }], async () => {
    await expect(getUserInfo(tokens)).resolves.toBeNull();
  });
  expect(stopped).toHaveLength(1);

  for (const body of [
    { sub: "", email: "alice@example.com", email_verified: true },
    { sub: "alice", email: "", email_verified: true },
  ]) {
    await withFetch([discovery, { ok: true, body }], async () => {
      await expect(getUserInfo(tokens)).resolves.toBeNull();
    });
  }
});
