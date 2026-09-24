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

// A supplied ID token that cannot be read is declined; only an absent one is
// resolved through UserInfo alone.
test("declines a supplied ID token whose payload is not JSON", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch([], async () => {
    await expect(
      getUserInfo({ idToken: "header.!!not-json!!.signature", accessToken: "access-token" }),
    ).resolves.toBeNull();
  });

  expect(requests).toEqual([]);
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
// profile like a non-OK response, rather than reject the OAuth callback. Each
// case gets fresh responses, and the rejections are created only when fetch is
// called, so no case is satisfied by a body an earlier case already consumed.
test("returns null when UserInfo fetch or JSON parsing rejects", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };
  const discovery = () =>
    new Response(JSON.stringify({ userinfo_endpoint: "https://idp.example/userinfo" }));
  // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test-only mock of a third-party response JSON boundary
  const invalidJson = () => ({ ok: true, json: () => Promise.reject(new Error("invalid JSON")) });
  // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test-only mock of an unavailable third-party request boundary
  const offline = () => Promise.reject(new Error("offline"));

  for (const [responses, calls] of [
    [[offline], 1],
    [[invalidJson], 1],
    [[discovery, offline], 2],
    [[discovery, invalidJson], 2],
  ] as const) {
    const fetch = vi.fn();
    for (const response of responses) fetch.mockImplementationOnce(response);
    vi.stubGlobal("fetch", fetch);
    await expect(getUserInfo(tokens)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(calls);
    vi.unstubAllGlobals();
  }
});

// Admission requires a verified email, so a thin ID token is admitted only once
// UserInfo has supplied the claim, and refused when UserInfo does not.
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

// An empty ID token is an absent one; a token with no payload segment is a
// supplied token that cannot be read, and is declined without a lookup.
test("resolves an empty ID token through UserInfo and declines one with no payload", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };
  const profile = {
    ok: true,
    body: { sub: "alice", email: "alice@example.com", email_verified: true },
  };

  const resolved = await withFetch([discovery, profile], async () => {
    await expect(getUserInfo({ idToken: "", accessToken: "access-token" })).resolves.toMatchObject({
      id: "alice",
      emailVerified: true,
    });
  });
  expect(resolved).toHaveLength(2);

  for (const idToken of ["no-periods-at-all", "header..signature"]) {
    const requests = await withFetch([], async () => {
      await expect(getUserInfo({ idToken, accessToken: "access-token" })).resolves.toBeNull();
    });
    expect(requests).toEqual([]);
  }
});

// An omitted or empty email must trigger UserInfo resolution rather than be
// returned as an identity.
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
  ]) {
    const requests = await withFetch([discovery, profile], async () => {
      await expect(
        getUserInfo({ idToken: jwt(claims), accessToken: "access-token" }),
      ).resolves.toMatchObject({ id: "alice", email: "alice@example.com", emailVerified: true });
    });
    expect(requests).toHaveLength(2);
  }
});

// An ID token identifies a subject or it identifies nothing: without a `sub`
// there is no identity for UserInfo claims to be matched against.
test("declines an ID token without a subject", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;

  for (const claims of [
    { email: "alice@example.com", email_verified: true },
    { sub: "", email: "alice@example.com", email_verified: true },
    { sub: 42, email: "alice@example.com", email_verified: true },
  ]) {
    const requests = await withFetch([], async () => {
      await expect(
        getUserInfo({ idToken: jwt(claims), accessToken: "access-token" }),
      ).resolves.toBeNull();
    });
    expect(requests).toEqual([]);
  }
});

// UserInfo claims describe the ID token's subject or they describe nobody:
// a profile for a different subject must not be used.
test("rejects a UserInfo profile whose subject differs from the ID token subject", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;
  const requests = await withFetch(
    [
      { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } },
      { ok: true, body: { sub: "bob", email: "bob@example.com", email_verified: true } },
    ],
    async () => {
      await expect(
        getUserInfo({
          idToken: jwt({ sub: "alice", email: "alice@example.com" }),
          accessToken: "access-token",
        }),
      ).resolves.toBeNull();
    },
  );

  expect(requests).toHaveLength(2);
});

// `emailVerified` is a boolean whatever the IdP sent: only a literal `true`
// verifies, and a non-string subject or email is no identity.
test("treats wrongly typed claims as unverified or absent", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;

  const stringClaim = await withFetch([], async () => {
    await expect(
      getUserInfo({
        idToken: jwt({ sub: "alice", email: "alice@example.com", email_verified: "true" }),
        accessToken: "access-token",
      }),
    ).resolves.toMatchObject({ id: "alice", emailVerified: false });
  });
  expect(stringClaim).toEqual([]);

  const discovery = { ok: true, body: { userinfo_endpoint: "https://idp.example/userinfo" } };
  const tokens = {
    idToken: jwt({ sub: "alice", email: "alice@example.com" }),
    accessToken: "access-token",
  };

  await withFetch(
    [
      discovery,
      { ok: true, body: { sub: "alice", email: "alice@example.com", email_verified: 1 } },
    ],
    async () => {
      await expect(getUserInfo(tokens)).resolves.toMatchObject({
        id: "alice",
        emailVerified: false,
      });
    },
  );

  for (const body of [
    { sub: 42, email: "alice@example.com", email_verified: true },
    { sub: "alice", email: { address: "alice@example.com" }, email_verified: true },
  ]) {
    await withFetch([discovery, { ok: true, body }], async () => {
      await expect(getUserInfo(tokens)).resolves.toBeNull();
    });
  }
});

// A `null` claim is present but not a positive assertion: it ends the lookup
// as an unverified email, and the gate refuses it.
test("never admits a null email_verified from either claim source", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;

  const requests = await withFetch([], async () => {
    const user = await getUserInfo({
      idToken: jwt({ sub: "alice", email: "alice@example.com", email_verified: null }),
      accessToken: "access-token",
    });
    expect(user).toMatchObject({ id: "alice", emailVerified: false });
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

// An empty access token is no token to spend: a thin ID token with nothing to
// present to UserInfo resolves to no profile.
test("treats an empty access token as absent", async () => {
  const getUserInfo = ssoProviderConfig(sso).getUserInfo!;

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
