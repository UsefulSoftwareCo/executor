// ---------------------------------------------------------------------------
// Fidelity suite — locks in every edge case the prior hand-rolled
// Google OAuth integrations handled, so future "simplifications" of the
// shared helpers fail loudly instead of silently breaking refresh / parsing /
// provider-specific quirks.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Ref, Schema } from "effect";
import type * as Tracer from "effect/Tracer";
import { HttpServerResponse } from "effect/unstable/http";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_REFRESH_SKEW_MS,
  OAuth2Error,
  PREVIEWABLE_BODY_FIELDS,
  PREVIEWABLE_WITHIN_ERROR_FIELDS,
  buildAuthorizationUrl,
  providerAuthorizeExtras,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  idTokenIdentityLabel,
  isPermanentTokenRejection,
  isUnusableSuccessTokenResponse,
  optionalScopesFromAuthorizationUrl,
  refreshAccessToken,
  shouldRefreshToken,
} from "./oauth-helpers";
import { serveTestHttpApp } from "./testing";

interface TokenCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: URLSearchParams;
  readonly jsonBody: unknown;
}

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
          jsonBody: request.headers["content-type"]?.startsWith("application/json")
            ? decodeJsonBody(bodyText)
            : null,
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

/** Records each span's attributes and its ending exit, so a test can assert on
 *  exactly what telemetry would export for the token-request span. */
interface RecordedSpan {
  readonly attributes: Map<string, unknown>;
  endExit?: unknown;
}

const makeRecordingTracer = (spans: Map<string, RecordedSpan>): Tracer.Tracer => ({
  span: (options) => {
    const record: RecordedSpan = { attributes: new Map() };
    spans.set(options.name, record);
    let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
    return {
      _tag: "Span",
      name: options.name,
      spanId: "0000000000000001",
      traceId: "00000000000000000000000000000001",
      parent: options.parent,
      annotations: options.annotations,
      get status() {
        return status;
      },
      attributes: record.attributes,
      links: options.links,
      sampled: options.sampled,
      kind: options.kind,
      end: (endTime, exit) => {
        record.endExit = exit;
        status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
      },
      attribute: (key, value) => {
        record.attributes.set(key, value);
      },
      event: () => undefined,
      addLinks: () => undefined,
    };
  },
});

const tokenResponseFetch =
  (body: unknown): typeof globalThis.fetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

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

describe("providerAuthorizeExtras (provider authorization quirks)", () => {
  it("adds access_type=offline + prompt=consent for the Google authorize host", () => {
    expect(providerAuthorizeExtras("https://accounts.google.com/o/oauth2/v2/auth")).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("adds optional_scope for workspace-owned HubSpot OAuth clients", () => {
    expect(providerAuthorizeExtras("https://app.hubspot.com/oauth/authorize")).toEqual({
      optional_scope: "content crm.objects.custom.read crm.schemas.custom.read",
    });
  });

  it("reads integration-declared optional_scope values from an authorization URL", () => {
    expect(
      optionalScopesFromAuthorizationUrl(
        "https://app.hubspot.com/oauth/authorize?optional_scope=crm.objects.contacts.read+crm.objects.contacts.write+crm.objects.contacts.read",
      ),
    ).toEqual(["crm.objects.contacts.read", "crm.objects.contacts.write"]);
    expect(optionalScopesFromAuthorizationUrl("not a url")).toEqual([]);
  });

  it("adds nothing for unrelated hosts, token hosts, or an unparseable URL", () => {
    expect(providerAuthorizeExtras("https://accounts.spotify.com/authorize")).toEqual({});
    expect(providerAuthorizeExtras("https://oauth2.googleapis.com/token")).toEqual({});
    expect(providerAuthorizeExtras("https://api.hubapi.com/oauth/v3/token")).toEqual({});
    expect(providerAuthorizeExtras("not a url")).toEqual({});
  });
});

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

  it("merges provider extra params without dropping them", () => {
    const url = new URL(
      buildAuthorizationUrl({
        ...baseInput,
        extraParams: {
          access_type: "offline",
          prompt: "consent",
        },
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
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
  it.effect("supports JSON token exchange with HTTP Basic client authentication", () =>
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
          requestFormat: "json",
        });
        const call = (yield* calls)[0]!;
        expect(call.headers["content-type"]).toBe("application/json");
        expect(call.headers["authorization"]).toBe("Basic Y2lkOmNzZWNyZXQ=");
        expect(call.jsonBody).toEqual({
          grant_type: "authorization_code",
          code: "abc",
          redirect_uri: "https://app.example.com/cb",
          code_verifier: "verifier",
        });
      }),
    ),
  );

  it.effect("supports JSON token exchange with client credentials in the body", () =>
    withTokenEndpoint(tokenResponse(validCodeBody), ({ tokenUrl, calls }) =>
      Effect.gen(function* () {
        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          clientSecret: "csecret",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
          requestFormat: "json",
        });
        expect((yield* calls)[0]!.jsonBody).toEqual({
          grant_type: "authorization_code",
          code: "abc",
          redirect_uri: "https://app.example.com/cb",
          code_verifier: "verifier",
          client_id: "cid",
          client_secret: "csecret",
        });
      }),
    ),
  );

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
          expect(result.idTokenIdentityLabel).toBe("user-1");
        }),
    ),
  );

  it.effect("extracts id_token email as the identity label", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: unsignedJwt({
          email: "alice@example.com",
          preferred_username: "alice",
          sub: "user-1",
        }),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.idTokenIdentityLabel).toBe("alice@example.com");
        }),
    ),
  );

  it.effect("falls back from id_token email to preferred_username then sub", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: unsignedJwt({
          preferred_username: "alice",
          sub: "user-1",
        }),
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const preferred = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(preferred.idTokenIdentityLabel).toBe("alice");
        }),
    ),
  );

  it("falls back to sub and ignores malformed id_tokens", () => {
    expect(idTokenIdentityLabel(unsignedJwt({ sub: "user-1" }))).toBe("user-1");
    expect(idTokenIdentityLabel("not-a-jwt")).toBeUndefined();
    expect(idTokenIdentityLabel(undefined)).toBeUndefined();
  });

  it.effect("ignores malformed id_tokens without failing the exchange", () =>
    withTokenEndpoint(
      tokenResponse({
        ...validCodeBody,
        id_token: "not-a-jwt",
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.access_token).toBe("tok");
          expect(result.idTokenIdentityLabel).toBeUndefined();
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
        expect(result.idTokenIdentityLabel).toBeUndefined();
      }),
    ),
  );

  it.effect("uses nested granted scopes for Slack-style user token responses", () =>
    withTokenEndpoint(
      tokenResponse({
        access_token: "xoxp-user-token",
        token_type: "Bearer",
        scope: "",
        authed_user: {
          id: "U12345",
          scope: "channels:read,chat:write",
        },
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            clientSecret: "csecret",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.access_token).toBe("xoxp-user-token");
          expect(result.scope).toBe("channels:read chat:write");
        }),
    ),
  );

  it.effect("selects the nested user grant when an empty top-level grant has a bot token", () =>
    withTokenEndpoint(
      tokenResponse({
        access_token: "xoxb-bot-token",
        token_type: "Bearer",
        scope: "",
        refresh_token: "bot-refresh-token",
        expires_in: 600,
        id_token: unsignedJwt({ email: "alice@example.com" }),
        authed_user: {
          scope: "channels:read,chat:write",
          access_token: "xoxp-user-token",
          token_type: "user",
          refresh_token: "user-refresh-token",
          expires_in: 3600,
        },
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            clientSecret: "csecret",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result).toMatchObject({
            access_token: "xoxp-user-token",
            token_type: "user",
            refresh_token: "user-refresh-token",
            expires_in: 3600,
            scope: "channels:read chat:write",
            idTokenIdentityLabel: "alice@example.com",
          });
        }),
    ),
  );

  it.effect("treats an empty standard scope as omitted", () =>
    withTokenEndpoint(
      tokenResponse({
        access_token: "user-token",
        token_type: "Bearer",
        scope: "   ",
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            clientSecret: "csecret",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.scope).toBeUndefined();
        }),
    ),
  );

  it.effect("normalizes Slack's comma-delimited top-level scopes", () =>
    Effect.gen(function* () {
      const result = yield* exchangeAuthorizationCode({
        tokenUrl: "https://slack.com/api/oauth.v2.user.access",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
        fetch: tokenResponseFetch({
          access_token: "xoxp-user-token",
          token_type: "Bearer",
          scope: "channels:read,chat:write,reactions:read",
        }),
      });

      expect(result.scope).toBe("channels:read chat:write reactions:read");
    }),
  );

  it.effect("preserves commas in scope tokens from non-Slack providers", () =>
    Effect.gen(function* () {
      const result = yield* exchangeAuthorizationCode({
        tokenUrl: "https://oauth.example.com/token",
        clientId: "cid",
        clientSecret: "csecret",
        redirectUrl: "https://app.example.com/cb",
        codeVerifier: "verifier",
        code: "abc",
        fetch: tokenResponseFetch({
          access_token: "provider-token",
          token_type: "Bearer",
          scope: "scope,with-comma other.scope",
        }),
      });

      expect(result.scope).toBe("scope,with-comma other.scope");
    }),
  );

  it.effect("keeps a standard top-level scope ahead of nested provider metadata", () =>
    withTokenEndpoint(
      tokenResponse({
        access_token: "user-token",
        token_type: "Bearer",
        scope: "standard.scope",
        authed_user: { scope: "provider.scope" },
      }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const result = yield* exchangeAuthorizationCode({
            tokenUrl,
            clientId: "cid",
            clientSecret: "csecret",
            redirectUrl: "https://app.example.com/cb",
            codeVerifier: "verifier",
            code: "abc",
          });
          expect(result.scope).toBe("standard.scope");
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

  // Non-secret description text must keep propagating even from a confidential
  // client: the scrub below removes ONLY the exact submitted secret, never the
  // AS's verdict prose around it.
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
              clientSecret: "csecret",
              redirectUrl: "https://cb",
              codeVerifier: "v",
              code: "c",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          expect(JSON.stringify(exit.cause)).toContain("Code expired");
          const failure = Cause.squash(exit.cause) as OAuth2Error;
          expect(failure.error).toBe("invalid_grant");
        }),
    ),
  );

  // The review's canary for the first-party secret leak. A provider that
  // echoes the submitted client_secret inside error_description would carry a
  // DEPLOYMENT-WIDE credential into the OAuth2Error message — and from there
  // into OAuthCompleteError, the popup's browser-visible errorDetails, and the
  // token-request span. Assert on the WHOLE rendered failure, not just the
  // message: what a log line or a `JSON.stringify` prints includes the retained
  // rejection, so an echo surviving anywhere in the cause is still a leak.
  it.effect("scrubs a client secret echoed in error_description from the whole failure", () => {
    const spans = new Map<string, RecordedSpan>();
    return withTokenEndpoint(
      () =>
        json(400, {
          error: "invalid_client",
          error_description:
            "authentication failed for secret SECRET-CANARY-must-not-escape, check your credentials",
        }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            exchangeAuthorizationCode({
              tokenUrl,
              clientId: "cid",
              clientSecret: "SECRET-CANARY-must-not-escape",
              redirectUrl: "https://cb",
              codeVerifier: "v",
              code: "c",
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          for (const rendered of [Cause.pretty(exit.cause), JSON.stringify(exit.cause)]) {
            expect(rendered).not.toContain("SECRET-CANARY-must-not-escape");
          }
          const failure = Cause.squash(exit.cause) as OAuth2Error;
          expect(failure).toBeInstanceOf(OAuth2Error);
          // Masked, not dropped: the verdict prose around the secret survives,
          // and so does everything classification and the span read.
          expect(failure.message).toContain("[redacted]");
          expect(failure.message).toContain("check your credentials");
          expect(failure.message).not.toContain("SECRET-CANARY-must-not-escape");
          expect(failure.error).toBe("invalid_client");
          expect(failure.status).toBe(400);
          // The token-request span — attributes AND ending exit — is what the
          // exporter sees; the echo must not survive there either.
          const tokenSpan = spans.get("executor.oauth.token_request");
          expect(tokenSpan?.attributes.get("executor.oauth.error_code")).toBe("invalid_client");
          const spanRendered = JSON.stringify({
            attributes: [...(tokenSpan?.attributes ?? [])],
            exit: tokenSpan?.endExit,
          });
          expect(spanRendered).not.toContain("SECRET-CANARY-must-not-escape");
        }),
    ).pipe(Effect.withTracer(makeRecordingTracer(spans)));
  });

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

  // A malformed HTTP 200 is the worst case in this module. The OAuth library
  // rejects it by handing back the PARSED BODY — the whole token response — and
  // these are ordinary provider quirks, not exotic inputs. That body is the one
  // the failure MESSAGE is built from, and the message is what is persisted onto
  // connection health, returned to the caller, and carried into telemetry. The
  // allowlist is what keeps the tokens out of it.
  //
  // Asserting on the message alone would not be enough. What a log line, a
  // Sentry event, or a crashing host actually prints is the WHOLE failure —
  // `Cause.pretty`, or a `JSON.stringify` of the cause — so a retained
  // rejection would carry the raw tokens straight past a clean message. These
  // assert the full rendering for that reason.
  //
  // The classifier has to keep working on exactly these inputs: a 2xx that
  // carried no usable token is a DEAD GRANT, and mis-reading it as transient is
  // what makes a connection retry forever instead of asking for re-auth. It
  // reads `status`, which this module lifts out of the rejection itself — so
  // redacting the rendering costs the classifier nothing.
  for (const [label, quirk] of [
    ["expires_in is null", { expires_in: null }],
    ["scope is an array", { scope: ["read"] }],
    ["token_type is not a string", { token_type: 7 }],
  ] as const) {
    it.effect(`keeps tokens out of the whole rendered failure when ${label}`, () =>
      withTokenEndpoint(
        () =>
          json(200, {
            access_token: "AT-CANARY-must-not-escape",
            refresh_token: "RT-CANARY-must-not-escape",
            token_type: "Bearer",
            ...quirk,
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
            const pretty = Cause.pretty(exit.cause);
            const serialized = JSON.stringify(exit.cause);
            for (const rendered of [pretty, serialized]) {
              expect(rendered).not.toContain("AT-CANARY-must-not-escape");
              expect(rendered).not.toContain("RT-CANARY-must-not-escape");
            }
            // Redacted, not dropped: the operator still sees which fields the
            // server sent, which is the whole point of previewing at all.
            expect(pretty).toContain("access_token");
            expect(pretty).toContain("[redacted]");
            // ...and the dead-grant verdict survives the redaction untouched.
            const failure = Cause.squash(exit.cause) as OAuth2Error;
            expect(failure).toBeInstanceOf(OAuth2Error);
            expect(failure.status).toBe(200);
            expect(isUnusableSuccessTokenResponse(failure)).toBe(true);
            expect(isPermanentTokenRejection(failure)).toBe(true);
          }),
      ),
    );
  }

  it.effect("redacts a credential echoed back under a field name nobody predicted", () =>
    withTokenEndpoint(
      // The failure the old name-based scrub could not see. It hid four known
      // field names, so a server that echoes a submitted secret — or returns its
      // token — under ANY other key walked straight through into the message,
      // and that message is persisted into connection health and shown to the
      // caller. An unknown field is exactly the case that has to fail closed.
      // No `error` field: a NON-conform body, which is the shape that actually
      // reaches the body preview. A conform error response is summarised from
      // its typed fields instead and never renders the body at all.
      () => json(400, { oops: "AT-CANARY-must-not-escape" }),
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
          expect(failure).not.toContain("AT-CANARY-must-not-escape");
          // Structure survives, so an operator still sees WHAT the server sent.
          expect(failure).toContain("oops");
          expect(failure).toContain("[redacted]");
        }),
    ),
  );

  it.effect("keeps an error array readable — the shape real providers answer with", () =>
    withTokenEndpoint(
      // Datadog answers a refused refresh this way. The preview has to stay
      // readable through the array, or the one body that most needs explaining
      // previews as nothing.
      () => json(400, { errors: ["invalid_grant - Invalid or expired refresh token"] }),
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
          expect(JSON.stringify(exit.cause)).toContain("Invalid or expired refresh token");
        }),
    ),
  );

  it.effect(
    "redacts an authorization code at the top level, but not an error envelope's code",
    () =>
      withTokenEndpoint(
        // `code` means two different things depending on where it sits: inside an
        // error envelope it names the failure, at the top level it is the RFC 6749
        // authorization code — credential material. Name alone cannot tell them
        // apart, so nesting has to.
        () =>
          json(400, {
            code: "AUTHZ-CODE-CANARY",
            error: { code: "invalid_client_id", message: "Invalid client_id" },
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
            expect(failure).not.toContain("AUTHZ-CODE-CANARY");
            expect(failure).toContain("invalid_client_id");
            expect(failure).toContain("Invalid client_id");
          }),
      ),
  );

  it.effect("applies the allowlist to a form-encoded body too", () =>
    withTokenEndpoint(
      // The other shape a token endpoint answers in. It used to take a
      // name-based scrub that could not match a field nobody had enumerated.
      () =>
        HttpServerResponse.text("session_token=FORM-CANARY-must-not-escape&error=invalid_request", {
          status: 400,
          headers: { "content-type": "application/x-www-form-urlencoded" },
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
          expect(failure).not.toContain("FORM-CANARY-must-not-escape");
          expect(failure).toContain("session_token");
          expect(failure).toContain("invalid_request");
        }),
    ),
  );

  it.effect("survives a pathologically nested body instead of dying", () =>
    withTokenEndpoint(
      () => {
        let nested: unknown = "AT-CANARY-must-not-escape";
        for (let i = 0; i < 10_000; i++) nested = { nest: nested };
        return json(400, nested);
      },
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
          // A DEFECT here would bypass the caller's error mapping entirely, so
          // the connection would never be marked as needing re-auth. The walk
          // must stop, not blow the stack.
          const rendered = JSON.stringify(exit.cause);
          expect(rendered).not.toContain("AT-CANARY-must-not-escape");
          expect(rendered).toContain("OAuth2Error");
          expect(rendered).not.toContain("Maximum call stack");
        }),
    ),
  );

  it("previews only the RFC 6749 error fields — widening this list is a security change", () => {
    // Nothing else pins the allowlist's CONTENTS, so adding a field to it would
    // otherwise be invisible: `token_type` and `scope` sit right beside the
    // tokens in a real response, and a future `access_token` entry would defeat
    // the whole redactor while every existing test stayed green.
    for (const field of ["token_type", "scope", "access_token", "refresh_token", "id_token"]) {
      expect(PREVIEWABLE_BODY_FIELDS.has(field)).toBe(false);
      expect(PREVIEWABLE_WITHIN_ERROR_FIELDS.has(field)).toBe(false);
    }
    expect([...PREVIEWABLE_BODY_FIELDS].sort()).toEqual([
      "error",
      "error_description",
      "error_uri",
      "errors",
    ]);
    expect([...PREVIEWABLE_WITHIN_ERROR_FIELDS].sort()).toEqual(["code", "detail", "message"]);
  });

  it.effect("matches allowlisted field names case-insensitively", () =>
    withTokenEndpoint(
      () => json(400, { Error_Description: "Code expired upstream", Oops: "MIXED-CANARY" }),
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
          expect(failure).toContain("Code expired upstream");
          expect(failure).not.toContain("MIXED-CANARY");
        }),
    ),
  );

  it.effect("reports the token endpoint by hostname, never by path", () =>
    withTokenEndpoint(
      () => HttpServerResponse.text("nope", { status: 404 }),
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
          // Persisted into connection health, so a tenant id in the path would
          // outlive the request. The host is enough to identify the server.
          expect(failure).toContain(new URL(tokenUrl).hostname);
          expect(failure).not.toContain(`${new URL(tokenUrl).origin}/token`);
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
  it.effect("routes token grant requests through the injected fetch", () =>
    withTokenEndpoint(tokenResponse(validRefreshBody), ({ tokenUrl }) =>
      Effect.gen(function* () {
        const seen: Array<{ url: string; method: string | undefined }> = [];
        const customFetch: typeof globalThis.fetch = (async (input, init) => {
          seen.push({
            url: input instanceof Request ? input.url : String(input),
            method: init?.method,
          });
          // oxlint-disable-next-line executor/no-raw-fetch -- boundary: test fetch adapter delegates to the local token endpoint
          return fetch(input, init);
        }) as typeof globalThis.fetch;

        yield* exchangeAuthorizationCode({
          tokenUrl,
          clientId: "cid",
          redirectUrl: "https://app.example.com/cb",
          codeVerifier: "verifier",
          code: "abc",
          fetch: customFetch,
        });
        yield* exchangeClientCredentials({
          tokenUrl,
          clientId: "cid",
          clientSecret: "secret",
          fetch: customFetch,
        });
        yield* refreshAccessToken({
          tokenUrl,
          clientId: "cid",
          refreshToken: "old",
          fetch: customFetch,
        });

        expect(seen).toEqual([
          { url: tokenUrl, method: "POST" },
          { url: tokenUrl, method: "POST" },
          { url: tokenUrl, method: "POST" },
        ]);
      }),
    ),
  );

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
  it.effect("persists provider-compatible JSON refresh rotation requests", () =>
    withTokenEndpoint(
      tokenResponse({ ...validRefreshBody, refresh_token: "rotated" }),
      ({ tokenUrl, calls }) =>
        Effect.gen(function* () {
          const result = yield* refreshAccessToken({
            tokenUrl,
            clientId: "cid",
            clientSecret: "csecret",
            refreshToken: "old",
            scopes: ["read", "offline_access"],
            requestFormat: "json",
          });
          expect(result.refresh_token).toBe("rotated");
          expect((yield* calls)[0]!.jsonBody).toEqual({
            grant_type: "refresh_token",
            refresh_token: "old",
            scope: "read offline_access",
            client_id: "cid",
            client_secret: "csecret",
          });
        }),
    ),
  );

  it.effect("normalizes Slack's comma-delimited scopes on refresh", () =>
    Effect.gen(function* () {
      const result = yield* refreshAccessToken({
        tokenUrl: "https://slack.com/api/oauth.v2.user.access",
        clientId: "cid",
        clientSecret: "csecret",
        refreshToken: "refresh-token",
        fetch: tokenResponseFetch({
          access_token: "xoxp-refreshed-token",
          token_type: "Bearer",
          scope: "channels:read,chat:write,reactions:read",
        }),
      });

      expect(result.scope).toBe("channels:read chat:write reactions:read");
    }),
  );

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

  // Datadog answers refresh grants with a non-conform envelope; the §5.2 code
  // must still be recovered so invalid_grant classifies as reauth-required
  // instead of a retried-forever transient (owner.com prod, 2026-07-30).
  it.effect("recovers invalid_grant from Datadog's non-conform errors array", () =>
    withTokenEndpoint(
      () =>
        json(400, {
          errors: ["invalid_grant - Invalid or expired refresh token or code verifier."],
        }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            refreshAccessToken({ tokenUrl, clientId: "cid", refreshToken: "old" }),
          );
          expect(error).toBeInstanceOf(OAuth2Error);
          expect((error as OAuth2Error).error).toBe("invalid_grant");
        }),
    ),
  );

  it.effect("recovers a bare non-conform `error` string outside the spec envelope shape", () =>
    withTokenEndpoint(
      () => json(400, { error: "invalid_grant", detail: 42 }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            refreshAccessToken({ tokenUrl, clientId: "cid", refreshToken: "old" }),
          );
          expect(error).toBeInstanceOf(OAuth2Error);
          expect((error as OAuth2Error).error).toBe("invalid_grant");
        }),
    ),
  );

  it.effect("does not invent a code from free-text error bodies", () =>
    withTokenEndpoint(
      () => json(400, { errors: ["something went wrong, try again later"] }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            refreshAccessToken({ tokenUrl, clientId: "cid", refreshToken: "old" }),
          );
          expect(error).toBeInstanceOf(OAuth2Error);
          expect((error as OAuth2Error).error).toBeUndefined();
        }),
    ),
  );

  it.effect("does not probe non-conform bodies on 5xx responses", () =>
    withTokenEndpoint(
      () => json(502, { errors: ["invalid_grant - upstream proxy noise"] }),
      ({ tokenUrl }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            refreshAccessToken({ tokenUrl, clientId: "cid", refreshToken: "old" }),
          );
          expect(error).toBeInstanceOf(OAuth2Error);
          expect((error as OAuth2Error).error).toBeUndefined();
        }),
    ),
  );

  // Every refusal the classifier can be handed as an HTTP RESPONSE — a
  // text/plain 400, a text/plain 404, a 200 carrying an error body, a 200 with
  // no usable token, a 5xx — is covered black-box by
  // `e2e/scenarios/oauth-refresh-rejected-non-json.test.ts`, where the test
  // authorization server can actually emit those bytes. The one shape no
  // authorization server can emit is *no answer at all*, so this case stays
  // here: it is the boundary between "the server said no" (permanent) and "we
  // never got an answer" (retryable), and only a dead socket expresses it.
  it.effect("a transport failure stays transient and carries no status", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        refreshAccessToken({
          tokenUrl: "http://127.0.0.1:1/token",
          clientId: "cid",
          refreshToken: "old",
          timeoutMs: 100,
        }),
      );
      expect(error.status).toBeUndefined();
      expect(isPermanentTokenRejection(error)).toBe(false);
    }),
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
