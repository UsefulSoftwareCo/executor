// ---------------------------------------------------------------------------
// Fidelity suite — locks in every edge case the prior hand-rolled
// google-discovery oauth.ts handled, so future "simplifications" of the
// shared helpers fail loudly instead of silently breaking refresh / parsing /
// provider-specific quirks.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_REFRESH_SKEW_MS,
  OAuth2Error,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  refreshAccessToken,
  shouldRefreshToken,
} from "./oauth-helpers";
import { serveTestHttpApp } from "./testing";

interface TokenCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: URLSearchParams;
}

type TokenHandler = (call: TokenCall) => HttpServerResponse.HttpServerResponse;

const json = (status: number, body: unknown): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status });

const serveTokenEndpoint = (handler: TokenHandler) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<readonly TokenCall[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const bodyText = yield* request.text;
        const call = {
          method: request.method,
          url: request.url ?? "/",
          headers: request.headers,
          body: new URLSearchParams(bodyText),
        };
        yield* Ref.update(calls, (all) => [...all, call]);
        return handler(call);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("token fixture failed", { status: 500 })),
        ),
      ),
    );

    return {
      tokenUrl: server.url("/token"),
      calls: Ref.get(calls),
    } as const;
  });

const withTokenEndpoint = <A, E>(
  handler: TokenHandler,
  use: (fixture: {
    readonly tokenUrl: string;
    readonly calls: Effect.Effect<readonly TokenCall[]>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* serveTokenEndpoint(handler);
      return yield* use(fixture);
    }),
  );

const validCodeBody = {
  access_token: "tok",
  token_type: "Bearer",
  refresh_token: "rtok",
  expires_in: 3600,
  scope: "read",
};

const validRefreshBody = { access_token: "tok2", token_type: "Bearer", expires_in: 3600 };

const jwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const unsignedJwt = (claims: Record<string, unknown>, alg = "RS256"): string =>
  `${jwtPart({ alg, typ: "JWT" })}.${jwtPart(claims)}.sig`;

const tokenResponse =
  (body: unknown): TokenHandler =>
  () =>
    json(200, body);

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  it("createPkceCodeVerifier returns a base64url string in the RFC 7636 length range", () => {
    for (let i = 0; i < 25; i++) {
      const verifier = createPkceCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    }
  });

  it("createPkceCodeChallenge matches the RFC 7636 Appendix A test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await createPkceCodeChallenge(verifier)).toBe(expected);
  });

  it("createPkceCodeVerifier produces unique values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(createPkceCodeVerifier());
    expect(seen.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizationUrl", () => {
  const baseInput = {
    authorizationUrl: "https://example.com/authorize",
    clientId: "client-123",
    redirectUrl: "https://app.example.com/callback",
    scopes: ["read", "write"] as const,
    state: "state-abc",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  };

  it("emits all RFC 6749 + PKCE params", () => {
    const url = new URL(buildAuthorizationUrl(baseInput));
    expect(url.origin + url.pathname).toBe("https://example.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("supports a custom scope separator (e.g. comma for legacy providers)", () => {
    const url = new URL(buildAuthorizationUrl({ ...baseInput, scopeSeparator: "," }));
    expect(url.searchParams.get("scope")).toBe("read,write");
  });

  it("omits scope when no scopes are requested", () => {
    const url = new URL(buildAuthorizationUrl({ ...baseInput, scopes: [] }));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("merges Google-style extra params without dropping them", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        extraParams: {
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("preserves pre-existing query params on the authorization URL", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        authorizationUrl: "https://example.com/auth?tenant=acme",
      }),
    );
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("client_id")).toBe("client-123");
  });

  it("includes RFC 8707 resource indicator when provided", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        resource: "https://api.example.com/v1/mcp",
      }),
    );
    expect(url.searchParams.get("resource")).toBe("https://api.example.com/v1/mcp");
  });

  it("omits resource parameter when not provided", () => {
    const url = new URL(buildAuthorizationUrl(baseInput));
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("rejects unsupported authorization URL schemes", () => {
    expect(() =>
      buildAuthorizationUrl({
        ...baseInput,
        authorizationUrl: "javascript:alert(1)",
      }),
    ).toThrow(/Authorization URL must use https: or loopback http:/);
    expect(() =>
      buildAuthorizationUrl({
        ...baseInput,
        authorizationUrl: "http://example.com/authorize",
      }),
    ).toThrow(/Authorization URL must use https: or loopback http:/);
  });

  it("allows HTTP authorization URLs when the caller opts into local HTTP", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        authorizationUrl: "http://example.com/authorize",
        endpointUrlPolicy: { allowHttp: true },
      }),
    );
    expect(url.origin + url.pathname).toBe("http://example.com/authorize");
  });
});

describe("exchangeAuthorizationCode", () => {
  it.effect("posts form-urlencoded body with grant_type=authorization_code and PKCE verifier", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        const result = yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          clientSecret: "csecret",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
        });
        expect(result.access_token).toBe("tok");
        const call = (yield* calls)[0]!;
        expect(call.method).toBe("POST");
        expect(call.headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
        expect(call.headers["accept"]).toContain("application/json");
        expect(call.body.get("grant_type")).toBe("authorization_code");
        expect(call.body.get("client_id")).toBe("cid");
        expect(call.body.get("client_secret")).toBe("csecret");
        expect(call.body.get("redirect_uri")).toBe("https://app.example.com/cb");
        expect(call.body.get("code_verifier")).toBe("verifier");
        expect(call.body.get("code")).toBe("abc");
      }),
    ),
  );

  it.effect("rejects unsupported token URL schemes before exchange", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        exchangeAuthorizationCode({
          tokenUrl: "http://example.com/token",
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(JSON.stringify(exit.cause)).toContain("Token URL must use https: or loopback http:");
    }),
  );

  it.effect("omits client_secret when none is provided (public clients with PKCE)", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
        });
        const body = (yield* calls)[0]!.body;
        expect(body.get("client_id")).toBe("cid");
        expect(body.has("client_secret")).toBe(false);
      }),
    ),
  );

  it.effect("includes RFC 8707 resource parameter on the token request when provided", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
          resource: "https://api.example.com/v1/mcp",
        });
        expect((yield* calls)[0]!.body.get("resource")).toBe("https://api.example.com/v1/mcp");
      }),
    ),
  );

  it.effect("omits resource parameter when not provided", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
        });
        expect((yield* calls)[0]!.body.has("resource")).toBe(false);
      }),
    ),
  );

  it.effect("strips id_tokens whose iss does not match AS metadata", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: unsignedJwt({
          iss: "https://us.posthog.com",
          aud: "cid",
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            issuerUrl: new URL(tokenUrl).origin,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.access_token).toBe("tok");
          expect(result.refresh_token).toBe("rtok");
        }),
    ),
  );

  it.effect("strips id_tokens whose aud does not match the client_id", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: unsignedJwt({
          iss: "http://127.0.0.1",
          aud: "another-client",
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            issuerUrl: new URL(tokenUrl).origin,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.access_token).toBe("tok");
        }),
    ),
  );

  it.effect("happy path: token endpoint with no id_token still parses normally", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl }) =>
      Effect.gen(function* () {
        const result = yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
        });
        expect(result.access_token).toBe("tok");
        expect(result.refresh_token).toBe("rtok");
        expect(result.expires_in).toBe(3600);
      }),
    ),
  );

  it.effect("still surfaces RFC 6749 §5.2 error envelopes after the id_token strip", () =>
    withTokenEndpoint(
      () =>
        json(400, {
          error: "invalid_grant",
          error_description: "authorization code expired",
        }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            exchangeAuthorizationCode({
              tokenUrl,
              clientId: "cid",
              redirectUrl: "https://app.example.com/cb",
              codeVerifier: "verifier",
              code: "abc",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const failure = JSON.stringify(exit.cause);
          expect(failure).toContain("OAuth2Error");
          expect(failure).toContain("invalid_grant");
          expect(failure).toContain("authorization code expired");
        }),
    ),
  );

  it.effect("strips id_tokens with algorithms not advertised in AS metadata", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: unsignedJwt(
          {
            iss: "http://127.0.0.1",
            aud: "cid",
            sub: "user-1",
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
          },
          "ES256",
        ),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            issuerUrl: new URL(tokenUrl).origin,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.access_token).toBe("tok");
          expect(result.refresh_token).toBe("rtok");
        }),
    ),
  );

  it.effect("uses HTTP Basic auth when clientAuth=basic (Stripe-style)", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          clientSecret: "csecret",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
          clientAuth: "basic",
        });
        const call = (yield* calls)[0]!;
        const expected = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
        expect(call.headers["authorization"]).toBe(expected);
        expect(call.body.has("client_id")).toBe(false);
        expect(call.body.has("client_secret")).toBe(false);
      }),
    ),
  );

  it.effect("uses the documented 20-second timeout default", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://cb",
          codeVerifier: "v",
          code: "c",
        });
        expect(OAUTH2_DEFAULT_TIMEOUT_MS).toBe(20_000);
      }),
    ),
  );

  it.effect("returns a typed OAuth2Error on transport failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        exchangeAuthorizationCode({
          tokenUrl: "http://127.0.0.1:1/token",
          clientId: "cid",
          redirectUrl: "https://cb",
          codeVerifier: "v",
          code: "c",
          timeoutMs: 100,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = JSON.stringify(exit.cause);
      expect(failure).toContain("OAuth2Error");
      expect(failure).toContain("OAuth token exchange failed");
    }),
  );

  it.effect("propagates RFC 6749 error_description text in the OAuth2Error", () =>
    withTokenEndpoint(
      () =>
        json(400, {
          error: "invalid_grant",
          error_description: "Code expired",
        }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            exchangeAuthorizationCode({
              tokenUrl,
              clientId: "cid",
              redirectUrl: "https://cb",
              codeVerifier: "v",
              code: "c",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          expect(JSON.stringify(exit.cause)).toContain("Code expired");
        }),
    ),
  );

  it.effect("includes HTTP status and body preview for non-OAuth token endpoint errors", () =>
    withTokenEndpoint(
      () => HttpServerResponse.text("route not found", { status: 404 }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            exchangeAuthorizationCode({
              tokenUrl,
              clientId: "cid",
              redirectUrl: "https://cb",
              codeVerifier: "v",
              code: "c",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const failure = JSON.stringify(exit.cause);
          expect(failure).toContain("HTTP 404");
          expect(failure).toContain("route not found");
        }),
    ),
  );

  it.effect("preserves provider error codes while redacting token endpoint secrets", () =>
    withTokenEndpoint(
      () =>
        json(400, {
          error: {
            code: "invalid_client_id",
            message: "Invalid client_id",
          },
          client_secret: "do-not-log",
        }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            exchangeAuthorizationCode({
              tokenUrl,
              clientId: "cid",
              redirectUrl: "https://cb",
              codeVerifier: "v",
              code: "c",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const failure = JSON.stringify(exit.cause);
          expect(failure).toContain("invalid_client_id");
          expect(failure).toContain("Invalid client_id");
          expect(failure).toContain("client_secret");
          expect(failure).toContain("[redacted]");
          expect(failure).not.toContain("do-not-log");
        }),
    ),
  );
});

describe("exchangeClientCredentials", () => {
  it.effect("rejects unsupported token URL schemes before exchange", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        exchangeClientCredentials({
          tokenUrl: "http://example.com/token",
          clientId: "cid",
          clientSecret: "secret",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(JSON.stringify(exit.cause)).toContain("Token URL must use https: or loopback http:");
    }),
  );
});

describe("refreshAccessToken", () => {
  it.effect("posts grant_type=refresh_token with the refresh token", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          clientSecret: "csecret",
          refreshToken: "old",
        });
        const body = (yield* calls)[0]!.body;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old");
        expect(body.get("client_id")).toBe("cid");
        expect(body.get("client_secret")).toBe("csecret");
      }),
    ),
  );

  it.effect("includes scope when scopes are provided", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          refreshToken: "old",
          scopes: ["a", "b"],
        });
        expect((yield* calls)[0]!.body.get("scope")).toBe("a b");
      }),
    ),
  );

  it.effect("omits scope when scopes is empty", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          refreshToken: "old",
          scopes: [],
        });
        expect((yield* calls)[0]!.body.has("scope")).toBe(false);
      }),
    ),
  );

  it.effect("includes RFC 8707 resource parameter on refresh requests when provided", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          refreshToken: "old",
          resource: "https://api.example.com/v1/mcp",
        });
        expect((yield* calls)[0]!.body.get("resource")).toBe("https://api.example.com/v1/mcp");
      }),
    ),
  );

  it.effect("strips refreshed id_tokens whose iss does not match AS metadata", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validRefreshBody,
        id_token: unsignedJwt({
          iss: "https://us.posthog.com",
          aud: "cid",
          sub: "user-1",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* refreshAccessToken({
            tokenUrl,
            issuerUrl: new URL(tokenUrl).origin,
            clientId: "cid",
            refreshToken: "old",
          });
          expect(result.access_token).toBe("tok2");
        }),
    ),
  );

  it.effect("strips refreshed id_tokens with algorithms not advertised in AS metadata", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validRefreshBody,
        id_token: unsignedJwt(
          {
            iss: "http://127.0.0.1",
            aud: "cid",
            sub: "user-1",
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
          },
          "ES256",
        ),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* refreshAccessToken({
            tokenUrl,
            issuerUrl: new URL(tokenUrl).origin,
            clientId: "cid",
            refreshToken: "old",
          });
          expect(result.access_token).toBe("tok2");
        }),
    ),
  );

  it.effect("happy path: refresh response with no id_token parses normally", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl }) =>
      Effect.gen(function* () {
        const result = yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          refreshToken: "old",
        });
        expect(result.access_token).toBe("tok2");
        expect(result.expires_in).toBe(3600);
      }),
    ),
  );
});

describe("shouldRefreshToken", () => {
  it("never refreshes when expiresAt is null", () => {
    expect(shouldRefreshToken({ expiresAt: null })).toBe(false);
  });

  it("returns true when within the skew window", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 30_000, now })).toBe(true);
  });

  it("returns false when comfortably in the future", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 5 * 60_000, now })).toBe(false);
  });

  it("uses the documented 60s default skew", () => {
    expect(OAUTH2_REFRESH_SKEW_MS).toBe(60_000);
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 59_000, now })).toBe(true);
    expect(shouldRefreshToken({ expiresAt: now + 61_000, now })).toBe(false);
  });

  it("respects a custom skew", () => {
    const now = 1_000_000;
    expect(shouldRefreshToken({ expiresAt: now + 30_000, now, skewMs: 10_000 })).toBe(false);
    expect(shouldRefreshToken({ expiresAt: now + 5_000, now, skewMs: 10_000 })).toBe(true);
  });
});

describe("OAuth2Error tagging", () => {
  it.effect("Effect failure channel carries OAuth2Error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        refreshAccessToken({
          tokenUrl: "http://127.0.0.1:1/token",
          clientId: "cid",
          refreshToken: "old",
          timeoutMs: 100,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(JSON.stringify(exit.cause)).toContain("OAuth2Error");
    }),
  );

  it("OAuth2Error is constructable directly with message and cause", () => {
    const err = new OAuth2Error({ message: "test", cause: { foo: 1 } });
    expect(err).toMatchObject({
      _tag: "OAuth2Error",
      message: "test",
      cause: { foo: 1 },
    });
  });
});
