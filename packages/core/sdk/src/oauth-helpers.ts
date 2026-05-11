// ---------------------------------------------------------------------------
// OAuth 2.0 helpers — generic, isomorphic building blocks.
//
// Thin wrappers around `oauth4webapi` (stateless; pure Web Crypto +
// `fetch`, no deps; runs unchanged in Node, CF Workers, and browsers).
// Each public helper is a single `Effect.tryPromise` call that delegates
// the RFC work to the library and normalises the failure surface into
// `OAuth2Error`.
//
// What stays hand-rolled:
//   - `OAuth2Error` — our tagged error; we want a stable shape across
//     every token-endpoint call
//   - `shouldRefreshToken` — skew check, trivial
//   - `buildAuthorizationUrl` — the library doesn't expose a raw
//     authorization-URL builder (it prefers PAR); a 30-line manual
//     construction keeps the call sync and lets callers opt out of PAR
// ---------------------------------------------------------------------------

import { Data, Effect, Predicate } from "effect";
import * as oauth from "oauth4webapi";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuth2Error extends Data.TaggedError("OAuth2Error")<{
  readonly message: string;
  /**
   * RFC 6749 §5.2 error code, when the token endpoint returned one
   * (`invalid_grant`, `invalid_client`, `unauthorized_client`, ...).
   * Callers use this to distinguish terminal failures (a refresh token
   * the AS no longer honours → re-auth required) from transient ones.
   */
  readonly error?: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Token response shape (RFC 6749 §5.1)
// ---------------------------------------------------------------------------

export type OAuth2TokenResponse = {
  readonly access_token: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh tokens this many ms before expiry to avoid mid-request expiration. */
export const OAUTH2_REFRESH_SKEW_MS = 60_000;

/** Default token-endpoint timeout. */
export const OAUTH2_DEFAULT_TIMEOUT_MS = 20_000;

export interface OAuthEndpointUrlPolicy {
  readonly allowHttp?: boolean;
}

const isLoopbackHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
};

export const isSupportedOAuthEndpointUrl = (
  value: string,
  policy: OAuthEndpointUrlPolicy = {},
): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    isLoopbackHttpUrl(value) ||
    (url.protocol === "http:" && policy.allowHttp === true)
  );
};

export const assertSupportedOAuthEndpointUrl = (
  value: string,
  label = "OAuth endpoint URL",
  policy: OAuthEndpointUrlPolicy = {},
): string => {
  if (isSupportedOAuthEndpointUrl(value, policy)) return value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous assertion helper used by URL constructors and Effect.try wrappers
  throw new TypeError(`${label} must use https: or loopback http:`);
};

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — straight delegation to `oauth4webapi`
// ---------------------------------------------------------------------------

export const createPkceCodeVerifier = (): string => oauth.generateRandomCodeVerifier();

export const createPkceCodeChallenge = (verifier: string): Promise<string> =>
  oauth.calculatePKCECodeChallenge(verifier);

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

export type BuildAuthorizationUrlInput = {
  readonly authorizationUrl: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  /** Pre-computed base64url S256 challenge (from `createPkceCodeChallenge`). */
  readonly codeChallenge: string;
  /** Separator between scopes. RFC 6749 says space; some providers use comma. */
  readonly scopeSeparator?: string;
  /** RFC 8707 Resource Indicator. MCP Authorization 2025-06-18 §"Resource
   *  Parameter Implementation" requires clients to send this on every
   *  authorization request, regardless of AS support. */
  readonly resource?: string;
  /** Provider-specific extras (e.g. Google's `access_type=offline`). */
  readonly extraParams?: Readonly<Record<string, string>>;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
};

/** Build an RFC 6749 §4.1.1 authorization URL. Sync; pre-computed
 *  challenge lets this stay out of the Promise world. */
export const buildAuthorizationUrl = (input: BuildAuthorizationUrlInput): string => {
  const url = new URL(
    assertSupportedOAuthEndpointUrl(
      input.authorizationUrl,
      "Authorization URL",
      input.endpointUrlPolicy,
    ),
  );
  const separator = input.scopeSeparator ?? " ";
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(separator));
  }
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", input.codeChallenge);
  if (input.resource) {
    url.searchParams.set("resource", input.resource);
  }
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

// ---------------------------------------------------------------------------
// Error mapping — `oauth4webapi`'s `process*Response` failure shapes are
// either a WWW-Authenticate challenge or an RFC 6749 §5.2 error body,
// both exposed via `.error` / `.error_description`. Probing the envelope
// preserves RFC 6749 error-code semantics (e.g., mapping `invalid_grant`
// to reauth-required) across wrappers.
// ---------------------------------------------------------------------------

const isOAuth2Error = Predicate.isTagged("OAuth2Error") as (cause: unknown) => cause is OAuth2Error;

const responseFromOAuthErrorCause = (cause: unknown): Response | undefined => {
  if (cause instanceof Response) return cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const envelope = cause as {
    readonly cause?: unknown;
    readonly response?: unknown;
  };
  if (envelope.response instanceof Response) return envelope.response;
  if (envelope.cause instanceof Response) return envelope.cause;
  return undefined;
};

const redactTokenEndpointBody = (body: string): string =>
  body
    .replaceAll(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replaceAll(
      /((?:access_token|refresh_token|id_token|client_secret|code)=)[^&\s]*/gi,
      "$1[redacted]",
    );

const tokenEndpointHttpSummary = async (response: Response): Promise<string> => {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const contentType = response.headers.get("content-type");
  const url = response.url ? ` from ${response.url}` : "";
  const parts = [`${status}${url}`];
  if (contentType) parts.push(`content-type ${contentType}`);
  const preview = await bodyPreviewFromResponse(response);
  if (preview) parts.push(`body: ${preview}`);
  return parts.join("; ");
};

const bodyPreviewFromResponse = async (response: Response): Promise<string | undefined> => {
  const text = await Promise.resolve()
    .then(() => response.clone().text())
    .then(
      (value) => value.trim(),
      () => "",
    );
  if (!text) return undefined;
  const redacted = redactTokenEndpointBody(text.replaceAll(/\s+/g, " "));
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
};

const toOAuth2Error = (cause: unknown): OAuth2Error => {
  if (isOAuth2Error(cause)) return cause;
  if (typeof cause === "object" && cause !== null) {
    const c = cause as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const code = typeof c.error === "string" ? c.error : undefined;
    const description =
      typeof c.error_description === "string"
        ? c.error_description
        : typeof c.message === "string"
          ? c.message
          : undefined;
    return new OAuth2Error({
      message: `OAuth token exchange failed: ${description ?? code ?? "unknown error"}`,
      error: code,
      cause,
    });
  }
  return new OAuth2Error({
    message: "OAuth token exchange failed",
    cause,
  });
};

const toOAuth2ErrorWithHttpSummary = (cause: unknown): Effect.Effect<OAuth2Error> => {
  if (isOAuth2Error(cause)) return Effect.succeed(cause);
  const base = toOAuth2Error(cause);
  const response = responseFromOAuthErrorCause(cause);
  if (!response) return Effect.succeed(base);
  return Effect.promise(() => tokenEndpointHttpSummary(response)).pipe(
    Effect.map(
      (summary) =>
        new OAuth2Error({
          message: `${base.message} (${summary})`,
          error: base.error,
          cause,
        }),
    ),
  );
};

const failOAuth2WithHttpSummary = (cause: unknown): Effect.Effect<never, OAuth2Error> =>
  toOAuth2ErrorWithHttpSummary(cause).pipe(Effect.flatMap((error) => Effect.fail(error)));

// ---------------------------------------------------------------------------
// oauth4webapi adapter helpers
// ---------------------------------------------------------------------------

export type ClientAuthMethod = "body" | "basic";

const asFromTokenUrl = (
  tokenUrl: string,
  endpointUrlPolicy: OAuthEndpointUrlPolicy = {},
): oauth.AuthorizationServer => {
  assertSupportedOAuthEndpointUrl(tokenUrl, "Token URL", endpointUrlPolicy);
  const url = new URL(tokenUrl);
  return {
    issuer: `${url.protocol}//${url.host}`,
    token_endpoint: tokenUrl,
  };
};

const asFromTokenUrlAndIssuer = (
  tokenUrl: string,
  issuerUrl: string | null | undefined,
  options: {
    readonly idTokenSigningAlgValuesSupported?: readonly string[];
    readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  } = {},
): oauth.AuthorizationServer => {
  const as = asFromTokenUrl(tokenUrl, options.endpointUrlPolicy);
  const withIssuer = issuerUrl ? { ...as, issuer: issuerUrl } : as;
  return options.idTokenSigningAlgValuesSupported
    ? {
        ...withIssuer,
        id_token_signing_alg_values_supported: [...options.idTokenSigningAlgValuesSupported],
      }
    : withIssuer;
};

const oauth4webapiRequestOptions = (
  targetUrl: string,
  timeoutMs: number | undefined,
  endpointUrlPolicy: OAuthEndpointUrlPolicy = {},
): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    signal: AbortSignal.timeout(timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
  };
  if (
    isLoopbackHttpUrl(targetUrl) ||
    (URL.canParse(targetUrl) &&
      new URL(targetUrl).protocol === "http:" &&
      endpointUrlPolicy.allowHttp === true)
  ) {
    (options as { [oauth.allowInsecureRequests]?: boolean })[oauth.allowInsecureRequests] = true;
  }
  return options;
};

const pickClientAuth = (
  clientSecret: string | null | undefined,
  method: ClientAuthMethod,
): oauth.ClientAuth => {
  if (!clientSecret) return oauth.None();
  return method === "basic"
    ? oauth.ClientSecretBasic(clientSecret)
    : oauth.ClientSecretPost(clientSecret);
};

const tokenResponseFrom = (r: oauth.TokenEndpointResponse): OAuth2TokenResponse => ({
  access_token: r.access_token,
  token_type: r.token_type,
  refresh_token: r.refresh_token,
  expires_in: typeof r.expires_in === "number" ? r.expires_in : undefined,
  scope: r.scope,
});

// MCP source connections are pure OAuth 2.0 — we never request `openid` and
// never consume `id_token`. Some providers (PostHog, etc.) front an OIDC
// backend and emit an `id_token` anyway; oauth4webapi then strict-validates
// its claims against the AS metadata and rejects mismatches we don't care
// about. Strip the field before delegation.
const stripIdToken = async (response: Response): Promise<Response> => {
  const body = await response
    .clone()
    .json()
    .then(
      (value: unknown) => value,
      () => null,
    );
  if (!body || typeof body !== "object" || !("id_token" in (body as Record<string, unknown>))) {
    return response;
  }
  const { id_token: _ignored, ...rest } = body as Record<string, unknown>;
  return new Response(JSON.stringify(rest), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const processTokenEndpointResponse = async (
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
): Promise<OAuth2TokenResponse> =>
  tokenResponseFrom(
    await oauth.processGenericTokenEndpointResponse(as, client, await stripIdToken(response)),
  );

// ---------------------------------------------------------------------------
// Exchange authorization code → tokens
// ---------------------------------------------------------------------------

export type ExchangeAuthorizationCodeInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly redirectUrl: string;
  readonly codeVerifier: string;
  readonly code: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly idTokenSigningAlgValuesSupported?: readonly string[];
  /** RFC 8707 Resource Indicator. MCP Auth spec MUST-requires this on
   *  the token request when the client knows the resource it intends
   *  to call. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
};

export const exchangeAuthorizationCode = (
  input: ExchangeAuthorizationCodeInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
        idTokenSigningAlgValuesSupported: input.idTokenSigningAlgValuesSupported,
        endpointUrlPolicy: input.endpointUrlPolicy,
      });
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(input.clientSecret, input.clientAuth ?? "body");
      // `authorizationCodeGrantRequest` requires its `callbackParameters`
      // to have been returned from `validateAuthResponse`. Our public API
      // takes the `code` directly (the UI already validated `state` by
      // looking up the session), so skip the library's state-validation
      // rail and go through the generic grant request instead.
      const params = new URLSearchParams({
        code: input.code,
        redirect_uri: input.redirectUrl,
        code_verifier: input.codeVerifier,
      });
      if (input.resource) {
        params.set("resource", input.resource);
      }
      const response = await oauth.genericTokenEndpointRequest(
        as,
        client,
        clientAuth,
        "authorization_code",
        params,
        oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs, input.endpointUrlPolicy),
      );
      return await processTokenEndpointResponse(as, client, response);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Exchange client credentials → tokens (RFC 6749 §4.4)
// ---------------------------------------------------------------------------

export type ExchangeClientCredentialsInput = {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
};

export const exchangeClientCredentials = (
  input: ExchangeClientCredentialsInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrl(input.tokenUrl, input.endpointUrlPolicy);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(input.clientSecret, input.clientAuth ?? "body");
      const params = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        params.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      const response = await oauth.clientCredentialsGrantRequest(
        as,
        client,
        clientAuth,
        params,
        oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs, input.endpointUrlPolicy),
      );
      const result = await oauth.processClientCredentialsResponse(as, client, response);
      return tokenResponseFrom(result);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Refresh access token
// ---------------------------------------------------------------------------

export type RefreshAccessTokenInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly refreshToken: string;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly idTokenSigningAlgValuesSupported?: readonly string[];
  /** RFC 8707 Resource Indicator — MCP spec MUST-requires this on
   *  refresh requests so the new access token's audience is bound to
   *  the same resource. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
};

export const refreshAccessToken = (
  input: RefreshAccessTokenInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
        idTokenSigningAlgValuesSupported: input.idTokenSigningAlgValuesSupported,
        endpointUrlPolicy: input.endpointUrlPolicy,
      });
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(input.clientSecret, input.clientAuth ?? "body");
      const extraParams = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        extraParams.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      if (input.resource) {
        extraParams.set("resource", input.resource);
      }
      const additionalParameters =
        Array.from(extraParams.keys()).length > 0 ? extraParams : undefined;
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        clientAuth,
        input.refreshToken,
        {
          ...oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs, input.endpointUrlPolicy),
          additionalParameters,
        },
      );
      const result = await oauth.processRefreshTokenResponse(
        as,
        client,
        await stripIdToken(response),
      );
      return tokenResponseFrom(result);
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(failOAuth2WithHttpSummary));

// ---------------------------------------------------------------------------
// Refresh-needed predicate
// ---------------------------------------------------------------------------

export const shouldRefreshToken = (input: {
  readonly expiresAt: number | null;
  readonly now?: number;
  readonly skewMs?: number;
}): boolean => {
  if (input.expiresAt === null) return false;
  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? OAUTH2_REFRESH_SKEW_MS;
  return input.expiresAt <= now + skew;
};
