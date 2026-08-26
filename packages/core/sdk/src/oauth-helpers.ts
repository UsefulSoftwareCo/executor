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

import { Data, Effect, Option, Predicate, Schema } from "effect";
import * as oauth from "oauth4webapi";

import type { SubjectTokenType } from "./oauth-client";

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
  readonly idTokenIdentityLabel?: string;
  /**
   * The raw OIDC ID token the endpoint returned, when it returned one.
   *
   * Named in camelCase deliberately: this is NOT the wire field (that one is
   * stripped before oauth4webapi validates the response — see `stripIdToken`),
   * so nothing can re-serialize this object as an RFC 6749 token response and
   * accidentally re-emit it.
   *
   * It exists for ONE caller: the enterprise work-identity link, which takes
   * custody of the ID token when the IdP issues no refresh token. The ordinary
   * connection mint reads named fields and never persists this.
   */
  readonly idToken?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh tokens this many ms before expiry to avoid mid-request expiration. */
export const OAUTH2_REFRESH_SKEW_MS = 60_000;

/** Default token-endpoint timeout. */
export const OAUTH2_DEFAULT_TIMEOUT_MS = 20_000;

/** RFC 8693 §2.1 token-exchange grant. */
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";

/** RFC 7523 §2.1 JWT bearer authorization grant — how an ID-JAG is redeemed
 *  at the Resource Authorization Server (id-jag draft §4.4). */
export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** id-jag draft §4.3 `requested_token_type` / §4.3.4 `issued_token_type`. */
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

/** id-jag draft §4.3.4: an ID-JAG is not an OAuth access token, so the token
 *  exchange response MUST carry this `token_type` sentinel. */
export const ID_JAG_TOKEN_TYPE_SENTINEL = "N_A";

export interface OAuthEndpointUrlPolicy {
  readonly allowHttp?: boolean;
}

export const isLoopbackHttpUrl = (value: string): boolean => {
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

/** RFC 6749 `state` — an unguessable correlation token minted by `oauth.start`
 *  and redeemed by `oauth.complete`. */
export const createOAuthState = (): string => oauth.generateRandomState();

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
  // Benign default kept by design: a single space is the RFC 6749 scope
  // separator. Callers targeting a legacy comma-separated provider pass
  // `scopeSeparator` explicitly (see the field's JSDoc).
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

/** Provider-specific authorize-URL extras that are NOT RFC 6749 params, so the
 *  generic flow must add them per-provider (keyed off the authorization host).
 *
 *  Google: `access_type=offline` + `prompt=consent` are required to receive (and
 *  keep receiving, across reconnects / scope changes) a REFRESH TOKEN — without
 *  them Google issues an access-token-only grant that dies in ~1h and a
 *  re-consent can silently keep the old scope set. Do not add
 *  `include_granted_scopes=true` here: with historical grants on the same Google
 *  consent app, Google folds those unrelated scopes into the new consent flow and
 *  can fail inside accounts.google.com before returning to our callback. */
export const providerAuthorizeExtras = (
  authorizationUrl: string,
): Readonly<Record<string, string>> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL() throws on invalid input → no provider extras
  try {
    const host = new URL(authorizationUrl).host.toLowerCase();
    if (host === "accounts.google.com") {
      return { access_type: "offline", prompt: "consent" };
    }
  } catch {
    // Unparseable authorization URL — let buildAuthorizationUrl surface the error.
  }
  return {};
};

// ---------------------------------------------------------------------------
// Regional token-endpoint rebind
//
// Some authorization servers publish a single static metadata document that
// advertises one region's token endpoint, but issue authorization codes that
// are only redeemable at the *regional* host the user's org actually lives on.
// The region comes back on the callback as a non-standard `domain` (or `site`)
// query param: Datadog returns `domain=us5.datadoghq.com` while its metadata
// statically advertises `app.datadoghq.com`. Redeeming the code at the
// advertised host then fails with `invalid_grant`.
//
// `rebindTokenEndpointHostToCallbackDomain` swaps ONLY the hostname of the
// configured token URL to the callback-supplied host, and ONLY when that host
// is a sibling subdomain of the configured one (same parent after stripping the
// leftmost DNS label, e.g. `app.datadoghq.com` and `us5.datadoghq.com` both
// reduce to `datadoghq.com`). The token request carries the client secret, the
// code, and the PKCE verifier, so an attacker-influenced `domain` must never be
// able to point it at an arbitrary origin. Anything that fails the sibling
// check, fails to parse, or isn't https falls back to the configured URL
// unchanged.
// ---------------------------------------------------------------------------

const hostnameFromCallbackDomain = (callbackDomain: string): string | undefined => {
  const trimmed = callbackDomain.trim();
  if (trimmed.length === 0) return undefined;
  // Datadog sends `domain` as a bare host and `site` as a full origin; accept
  // either by tolerating an optional scheme, then taking only the hostname.
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  // A legitimate regional host carries no port, credentials, or path.
  if (url.port !== "" || url.username !== "" || url.password !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url.hostname.toLowerCase();
};

/** Parent domain after stripping the leftmost DNS label, or `undefined` when
 *  the host has no sibling space (a single label, or a parent that is a bare
 *  TLD). `app.datadoghq.com` -> `datadoghq.com`; `foo.com` -> undefined. */
const siblingParentDomainOf = (hostname: string): string | undefined => {
  const labels = hostname.split(".");
  if (labels.length < 3) return undefined;
  const parent = labels.slice(1).join(".");
  // Require the parent to itself be multi-label so a 2-label configured host
  // can never rebind across an entire TLD (e.g. foo.com -> bar.com).
  return parent.includes(".") ? parent : undefined;
};

export const rebindTokenEndpointHostToCallbackDomain = (
  configuredTokenUrl: string,
  callbackDomain: string | null | undefined,
): string => {
  if (!callbackDomain) return configuredTokenUrl;
  if (!URL.canParse(configuredTokenUrl)) return configuredTokenUrl;
  const configured = new URL(configuredTokenUrl);
  if (configured.protocol !== "https:") return configuredTokenUrl;
  const targetHost = hostnameFromCallbackDomain(callbackDomain);
  if (!targetHost) return configuredTokenUrl;
  const configuredHost = configured.hostname.toLowerCase();
  if (targetHost === configuredHost) return configuredTokenUrl;
  const configuredParent = siblingParentDomainOf(configuredHost);
  const targetParent = siblingParentDomainOf(targetHost);
  if (!configuredParent || !targetParent || configuredParent !== targetParent) {
    return configuredTokenUrl;
  }
  const rebound = new URL(configuredTokenUrl);
  rebound.hostname = targetHost;
  return rebound.toString();
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

/** Read a response body as text without throwing. Null means the body could not
 *  be read at all — already consumed, or the connection died mid-stream — which
 *  is a DIFFERENT outcome from a body that read fine and said something we did
 *  not expect. The read is passed as a thunk so that `.clone()` throwing on an
 *  already-consumed body is caught here too, rather than escaping as a defect. */
const safeBodyText = async (read: () => Promise<string>): Promise<string | null> =>
  Promise.resolve()
    .then(read)
    .then(
      (value) => value,
      () => null,
    );

/** Structurally probe an untrusted upstream body. Returns `undefined` rather
 *  than a fabricated value when it is not JSON; the caller's schema decode
 *  decides what an absent envelope means. */
const safeJson = (text: string): unknown => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing an untrusted token-endpoint body; unparseable means "no OAuth envelope"
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: same untrusted-body probe; the value is only decoded through a schema or inspected against a closed code set
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Read and JSON-probe a response body without consuming the caller's copy. */
const safeJsonFromResponse = async (response: Response): Promise<unknown> => {
  const text = await safeBodyText(() => response.clone().text());
  return text === null ? undefined : safeJson(text);
};

const bodyPreviewFromResponse = async (response: Response): Promise<string | undefined> => {
  const text = (await safeBodyText(() => response.clone().text()))?.trim() ?? "";
  if (!text) return undefined;
  const redacted = redactTokenEndpointBody(text.replaceAll(/\s+/g, " "));
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
};

// RFC 6749 §5.2's closed set. Only these are ever recovered from a
// non-conform body: a free-text match against an open set would let an
// arbitrary error message masquerade as an AS verdict.
const RFC6749_TOKEN_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
] as const;

const rfc6749CodeFromCandidate = (candidate: unknown): string | undefined => {
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return RFC6749_TOKEN_ERROR_CODES.find(
    (code) => trimmed === code || trimmed.startsWith(`${code} `) || trimmed.startsWith(`${code}:`),
  );
};

/** Recover the AS's §5.2 verdict from an already-parsed error body that is not
 *  a conform RFC 6749 envelope. Some ASes wrap the code in a shape of their own
 *  — Datadog answers refresh grants with `{"errors": ["invalid_grant - Invalid
 *  or expired refresh token or code verifier."]}` — and without this probe a
 *  definitive `invalid_grant` (dead refresh token, reconnect required) is
 *  classified as a transient failure and retried forever instead of surfacing a
 *  re-auth. Takes the parsed value, not the text, so the caller parses once. */
const oauthErrorCodeFromNonConformBody = (parsed: unknown): string | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const envelope = parsed as { readonly error?: unknown; readonly errors?: unknown };
  const direct = rfc6749CodeFromCandidate(envelope.error);
  if (direct) return direct;
  if (Array.isArray(envelope.errors)) {
    for (const entry of envelope.errors) {
      const code = rfc6749CodeFromCandidate(entry);
      if (code) return code;
    }
  }
  return undefined;
};

// The RFC 6749 §5.2 error envelope. Its code is NOT constrained to the closed
// set above: extension grants define their own (RFC 8693 §2.2.2 adds
// `invalid_target`, which the ID-JAG exchange leans on), and a conform envelope
// is the authorization server naming its own verdict. Only the free-text
// recovery has to stay closed.
const TokenErrorEnvelopeSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});
const decodeTokenErrorEnvelope = Schema.decodeUnknownOption(TokenErrorEnvelopeSchema);

/** The authorization server's verdict as read off an error-response body: its
 *  conform §5.2 envelope when it sent one, otherwise the closed-set recovery
 *  from a non-conform envelope. ONE classifier, so every token path — code
 *  exchange, refresh, client credentials, ID-JAG exchange, ID-JAG redemption —
 *  reaches the same conclusion about the same body. */
const oauthErrorFromResponseBody = (
  text: string,
): { readonly code: string; readonly description?: string } | undefined => {
  const parsed = safeJson(text);
  return Option.match(decodeTokenErrorEnvelope(parsed), {
    onNone: () => {
      const code = oauthErrorCodeFromNonConformBody(parsed);
      return code === undefined ? undefined : { code };
    },
    onSome: (envelope) => ({
      code: envelope.error,
      ...(envelope.error_description === undefined
        ? {}
        : { description: envelope.error_description }),
    }),
  });
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

/** Turn whatever a token request failed with into an `OAuth2Error` carrying the
 *  HTTP summary and, when the body admits one, the authorization server's own
 *  §5.2 code.
 *
 *  `fallbackMessage` is for the paths that hold the error Response directly
 *  rather than catching a thrown oauth4webapi error: there is no library
 *  message to build on, so the caller names the step instead. */
const toOAuth2ErrorWithHttpSummary = (
  cause: unknown,
  options?: { readonly fallbackMessage?: string },
): Effect.Effect<OAuth2Error> => {
  if (isOAuth2Error(cause)) return Effect.succeed(cause);
  const base = toOAuth2Error(cause);
  const response = responseFromOAuthErrorCause(cause);
  if (!response) return Effect.succeed(base);
  return Effect.promise(async () => {
    const summary = await tokenEndpointHttpSummary(response);
    // A 4xx the spec parser refused may still carry the AS's verdict in its
    // body; recover it so classification (invalid_grant → reauth-required,
    // invalid_target → blocked-by-admin) sees the code instead of a code-less
    // "transient". 5xx is left code-less on purpose: it is a transport verdict.
    const recovered =
      base.error === undefined && response.status >= 400 && response.status < 500
        ? oauthErrorFromResponseBody((await safeBodyText(() => response.clone().text())) ?? "")
        : undefined;
    const headline = options?.fallbackMessage ?? base.message;
    const described =
      options?.fallbackMessage === undefined || recovered === undefined
        ? headline
        : `${headline}: ${recovered.code}${
            recovered.description === undefined ? "" : ` — ${recovered.description}`
          }`;
    return new OAuth2Error({
      message: `${described} (${summary})`,
      error: base.error ?? recovered?.code,
      cause,
    });
  });
};

const failOAuth2WithHttpSummary = (cause: unknown): Effect.Effect<never, OAuth2Error> =>
  toOAuth2ErrorWithHttpSummary(cause).pipe(Effect.flatMap((error) => Effect.fail(error)));

/** Fail from a token-endpoint error Response the caller holds directly — the
 *  `genericTokenEndpointRequest` paths, where oauth4webapi hands back the raw
 *  response instead of throwing. Classification runs through the SAME machinery
 *  every other token path uses, including the non-conform recovery: without it
 *  an IdP answering `{"errors":["invalid_grant - …"]}` reads as a transport
 *  failure and gets retried forever instead of asking for a fresh sign-on. */
const failOAuth2FromErrorResponse = (
  response: Response,
  fallbackMessage: string,
): Effect.Effect<never, OAuth2Error> =>
  toOAuth2ErrorWithHttpSummary(response, { fallbackMessage }).pipe(
    Effect.flatMap((error) => Effect.fail(error)),
  );

/** Trace one token-endpoint round trip. This is the ONLY place a token request
 *  can be observed: oauth4webapi drives the raw global `fetch`, not Effect's
 *  HttpClient, so no `http.client` span exists underneath — without this span
 *  the AS's latency and refusal rate are invisible.
 *
 *  Attribute discipline: hostname (never the full URL — some providers carry
 *  tenant ids in the path), the grant literal, the auth method, and on failure
 *  the AS's RFC 6749 §5.2 code. Never the OAuth2Error message (it embeds the
 *  response URL and a body preview), never token or code material. */
const withTokenRequestSpan =
  (input: {
    readonly grantType:
      | "authorization_code"
      | "client_credentials"
      | "refresh_token"
      | typeof TOKEN_EXCHANGE_GRANT_TYPE
      | typeof JWT_BEARER_GRANT_TYPE;
    readonly tokenUrl: string;
    readonly clientAuth: ClientAuthMethod | undefined;
    readonly hasResource: boolean;
  }) =>
  <A>(effect: Effect.Effect<A, OAuth2Error>): Effect.Effect<A, OAuth2Error> =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          ...(error.error !== undefined ? { "executor.oauth.error_code": error.error } : {}),
        }),
      ),
      Effect.withSpan("executor.oauth.token_request", {
        attributes: {
          "executor.oauth.grant_type": input.grantType,
          "executor.oauth.token_host": hostnameForTelemetry(input.tokenUrl),
          "executor.oauth.client_auth": input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
          "executor.oauth.has_resource": input.hasResource,
        },
      }),
    );

/** The hostname alone — a malformed URL yields "invalid" rather than leaking
 *  whatever string failed to parse. */
const hostnameForTelemetry = (url: string): string => URL.parse(url)?.hostname ?? "invalid";

// ---------------------------------------------------------------------------
// oauth4webapi adapter helpers
// ---------------------------------------------------------------------------

export type ClientAuthMethod = "body" | "basic";

/**
 * The token-endpoint client-auth transport used when a caller doesn't specify
 * one. `"body"` is `client_secret_post` (the secret in the form body) — the
 * method our DCR registers (`token_endpoint_auth_method: client_secret_post`)
 * and the one every confidential client in the v2 model uses. EXPLICIT and
 * documented rather than a hidden inline `?? "body"`: callers that need
 * `client_secret_basic` pass `clientAuth: "basic"`. For PUBLIC clients (no
 * secret) the method is irrelevant — `pickClientAuth` returns `None()`.
 */
export const DEFAULT_CLIENT_AUTH_METHOD: ClientAuthMethod = "body";

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
  customFetch?: typeof globalThis.fetch,
): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    signal: AbortSignal.timeout(timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
  };
  if (customFetch) {
    (options as { [oauth.customFetch]?: typeof globalThis.fetch })[oauth.customFetch] = customFetch;
  }
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

// Select the token-endpoint client authentication. The secret's presence is the
// EXPLICIT public-vs-confidential discriminator in the v2 model: a registered
// client either has a secret (confidential — authenticate it) or has none
// (public PKCE — `None()`, RFC 7636). This is not a silent guess: `loadClient`
// persists a non-empty secret for confidential clients and null/"" for public
// ones, so an absent secret here unambiguously means "public client". The
// `method` only chooses HOW a present secret is sent (post vs basic).
const pickClientAuth = (
  clientSecret: string | null | undefined,
  method: ClientAuthMethod,
): oauth.ClientAuth => {
  if (!clientSecret) return oauth.None();
  return method === "basic"
    ? oauth.ClientSecretBasic(clientSecret)
    : oauth.ClientSecretPost(clientSecret);
};

const normalizedTokenScope = (
  as: oauth.AuthorizationServer,
  scope: string | undefined,
): string | undefined => {
  if (scope === undefined || scope.trim().length === 0) return undefined;
  const tokenEndpoint = typeof as.token_endpoint === "string" ? URL.parse(as.token_endpoint) : null;
  const isSlackTokenEndpoint =
    tokenEndpoint?.hostname.toLowerCase() === "slack.com" &&
    (tokenEndpoint.pathname === "/api/oauth.v2.access" ||
      tokenEndpoint.pathname === "/api/oauth.v2.user.access");
  if (!isSlackTokenEndpoint) return scope;

  const normalized = scope
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
  return normalized.length > 0 ? normalized : undefined;
};

const tokenResponseFrom = (
  as: oauth.AuthorizationServer,
  r: oauth.TokenEndpointResponse,
): OAuth2TokenResponse => ({
  access_token: r.access_token,
  token_type: r.token_type,
  refresh_token: r.refresh_token,
  expires_in: typeof r.expires_in === "number" ? r.expires_in : undefined,
  scope: normalizedTokenScope(as, typeof r.scope === "string" ? r.scope : undefined),
});

const JwtClaims = Schema.Record(Schema.String, Schema.Unknown);
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims));

const stringClaim = (
  claims: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = claims[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const decodeJwtPayload = (token: string): Readonly<Record<string, unknown>> | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return null;
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  // atob yields latin1 code units; JWT payloads are UTF-8 bytes, so re-decode
  // them properly or non-ASCII claim values (accented emails, names) garble.
  const utf8 = new TextDecoder().decode(
    Uint8Array.from(globalThis.atob(padded), (char) => char.charCodeAt(0)),
  );
  const decoded = decodeJwtClaims(utf8);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const idTokenIdentityLabel = (idToken: string | undefined): string | undefined => {
  if (!idToken) return undefined;
  const claims = decodeJwtPayload(idToken);
  if (!claims) return undefined;
  return (
    stringClaim(claims, "email") ??
    stringClaim(claims, "preferred_username") ??
    stringClaim(claims, "sub")
  );
};

/** The account an ID token names, as far as a display and a deadline go.
 *
 *  Read UNVERIFIED, and only ever used that way: these claims describe a token
 *  we already hold from a token endpoint we just authenticated to, so they are
 *  provenance for the user's benefit, never an authorization input. `expiresAt`
 *  is epoch MILLIseconds (`exp` is seconds on the wire). */
export const idTokenAccountFacts = (
  idToken: string | undefined,
): {
  readonly subject: string | null;
  readonly label: string | null;
  readonly expiresAt: number | null;
} => {
  const claims = idToken === undefined ? null : decodeJwtPayload(idToken);
  if (claims === null) return { subject: null, label: null, expiresAt: null };
  const exp = claims.exp;
  return {
    subject: stringClaim(claims, "sub") ?? null,
    label: idTokenIdentityLabel(idToken) ?? null,
    expiresAt: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
  };
};

type StrippedTokenResponse = {
  readonly response: Response;
  readonly idTokenIdentityLabel?: string;
  readonly idToken?: string;
};

const NestedAuthedUserScope = Schema.Struct({
  authed_user: Schema.Struct({
    scope: Schema.String,
    access_token: Schema.optional(Schema.String),
    token_type: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
    expires_in: Schema.optional(Schema.Number),
  }),
});
const decodeNestedAuthedUserScope = Schema.decodeUnknownOption(NestedAuthedUserScope);

type NestedAuthedUserGrant = {
  readonly scope: string;
  readonly accessToken?: string;
  readonly tokenType?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
};

/** Slack's MCP-oriented `oauth.v2.user.access` endpoint returns its granted
 * user scopes under `authed_user.scope` instead of the RFC 6749 top-level
 * `scope`. Preserve that provider extension only when the standard field is
 * absent or empty, and normalize Slack's comma separator back to RFC space-delimited
 * scope syntax at this boundary. */
const nestedAuthedUserGrant = async (
  response: Response,
): Promise<NestedAuthedUserGrant | undefined> => {
  const decoded = decodeNestedAuthedUserScope(await safeJsonFromResponse(response));
  if (Option.isNone(decoded)) return undefined;
  const normalized = decoded.value.authed_user.scope
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
  if (normalized.length === 0) return undefined;
  const nestedAccessToken = decoded.value.authed_user.access_token;
  const nestedTokenType = decoded.value.authed_user.token_type;
  const nestedRefreshToken = decoded.value.authed_user.refresh_token;
  const nestedExpiresIn = decoded.value.authed_user.expires_in;
  return {
    scope: normalized,
    ...(nestedAccessToken === undefined ? {} : { accessToken: nestedAccessToken }),
    ...(nestedTokenType === undefined ? {} : { tokenType: nestedTokenType }),
    ...(nestedRefreshToken === undefined ? {} : { refreshToken: nestedRefreshToken }),
    ...(nestedExpiresIn === undefined ? {} : { expiresIn: nestedExpiresIn }),
  };
};

// MCP source connections are pure OAuth 2.0. Some providers (PostHog, etc.)
// front an OIDC backend and emit an `id_token` anyway; oauth4webapi then
// strict-validates its claims against the AS metadata and rejects mismatches we
// don't care about. Strip the field before delegation, after extracting the
// optional display label when the token endpoint returned OIDC account claims.
const stripIdToken = async (response: Response): Promise<StrippedTokenResponse> => {
  const body = await safeJsonFromResponse(response);
  if (!body || typeof body !== "object" || !("id_token" in (body as Record<string, unknown>))) {
    return { response };
  }
  const { id_token: idToken, ...rest } = body as Record<string, unknown>;
  const label = typeof idToken === "string" ? idTokenIdentityLabel(idToken) : undefined;
  return {
    response: new Response(JSON.stringify(rest), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    ...(label ? { idTokenIdentityLabel: label } : {}),
    ...(typeof idToken === "string" && idToken.length > 0 ? { idToken } : {}),
  };
};

const processTokenEndpointResponse = async (
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
): Promise<OAuth2TokenResponse> => {
  const stripped = await stripIdToken(response);
  const providerUserGrant = await nestedAuthedUserGrant(stripped.response);
  const parsed = tokenResponseFrom(
    as,
    await oauth.processGenericTokenEndpointResponse(as, client, stripped.response),
  );
  const token =
    parsed.scope === undefined && providerUserGrant !== undefined
      ? providerUserGrant.accessToken === undefined
        ? { ...parsed, scope: providerUserGrant.scope }
        : {
            access_token: providerUserGrant.accessToken,
            token_type: providerUserGrant.tokenType,
            refresh_token: providerUserGrant.refreshToken,
            expires_in: providerUserGrant.expiresIn,
            scope: providerUserGrant.scope,
          }
      : parsed;
  return {
    ...token,
    ...(stripped.idTokenIdentityLabel === undefined
      ? {}
      : { idTokenIdentityLabel: stripped.idTokenIdentityLabel }),
    ...(stripped.idToken === undefined ? {} : { idToken: stripped.idToken }),
  };
};

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
  readonly fetch?: typeof globalThis.fetch;
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
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
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
        oauth4webapiRequestOptions(
          input.tokenUrl,
          input.timeoutMs,
          input.endpointUrlPolicy,
          input.fetch,
        ),
      );
      return await processTokenEndpointResponse(as, client, response);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(failOAuth2WithHttpSummary),
    withTokenRequestSpan({
      grantType: "authorization_code",
      tokenUrl: input.tokenUrl,
      clientAuth: input.clientAuth,
      hasResource: input.resource !== undefined,
    }),
  );

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
  /** RFC 8707 Resource Indicator. MCP Authorization 2025-06-18 requires this
   *  on token requests when the client knows the protected resource. */
  readonly resource?: string;
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

export const exchangeClientCredentials = (
  input: ExchangeClientCredentialsInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrl(input.tokenUrl, input.endpointUrlPolicy);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
      const params = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        params.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      if (input.resource) {
        params.set("resource", input.resource);
      }
      const response = await oauth.clientCredentialsGrantRequest(
        as,
        client,
        clientAuth,
        params,
        oauth4webapiRequestOptions(
          input.tokenUrl,
          input.timeoutMs,
          input.endpointUrlPolicy,
          input.fetch,
        ),
      );
      const result = await oauth.processClientCredentialsResponse(as, client, response);
      return tokenResponseFrom(as, result);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(failOAuth2WithHttpSummary),
    withTokenRequestSpan({
      grantType: "client_credentials",
      tokenUrl: input.tokenUrl,
      clientAuth: input.clientAuth,
      hasResource: input.resource !== undefined,
    }),
  );

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
  readonly fetch?: typeof globalThis.fetch;
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
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
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
          ...oauth4webapiRequestOptions(
            input.tokenUrl,
            input.timeoutMs,
            input.endpointUrlPolicy,
            input.fetch,
          ),
          additionalParameters,
        },
      );
      const result = await oauth.processRefreshTokenResponse(
        as,
        client,
        (await stripIdToken(response)).response,
      );
      return tokenResponseFrom(as, result);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(failOAuth2WithHttpSummary),
    withTokenRequestSpan({
      grantType: "refresh_token",
      tokenUrl: input.tokenUrl,
      clientAuth: input.clientAuth,
      hasResource: input.resource !== undefined,
    }),
  );

// ---------------------------------------------------------------------------
// RFC 8693 token exchange → Identity Assertion JWT Authorization Grant
//
// The IdP's response is NOT an OAuth access-token response: `token_type` is the
// `N_A` sentinel (id-jag draft §4.3.4), which `oauth4webapi`'s response
// processors reject outright. So the request goes out through the library's
// grant-agnostic `genericTokenEndpointRequest` and the body is parsed here,
// against the exact shape the draft specifies.
// ---------------------------------------------------------------------------

const IdJagResponseSchema = Schema.Struct({
  access_token: Schema.String,
  issued_token_type: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
}).annotate({ identifier: "IdJagTokenExchangeResponse" });
const decodeIdJagResponse = Schema.decodeUnknownEffect(IdJagResponseSchema);

/** An Identity Assertion JWT Authorization Grant as returned by the IdP's token
 *  exchange (id-jag draft §4.3.4). `assertion` is the JWT itself — carried in
 *  the response's `access_token` field "for historical reasons", per the draft,
 *  and renamed here so no caller mistakes it for an access token. */
export type IdJagGrant = {
  readonly assertion: string;
  /** Granted scopes echoed by the IdP. Absent when the IdP granted exactly what
   *  was requested; policy MAY narrow the set (§4.3.3). */
  readonly scope?: string;
  readonly expiresIn?: number;
};

export type ExchangeSubjectTokenForIdJagInput = {
  /** The enterprise IdP's token endpoint. */
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  /** The client's registration AT THE IdP — a different relationship from its
   *  registration at the Resource Authorization Server (id-jag draft §5). */
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly clientAuth?: ClientAuthMethod;
  /** The identity assertion (or IdP refresh token) standing in for the user. */
  readonly subjectToken: string;
  readonly subjectTokenType: SubjectTokenType;
  /** REQUIRED — the issuer identifier of the Resource Authorization Server
   *  (id-jag draft §4.3; EMA profile §4 narrows it to exactly that). */
  readonly audience: string;
  /** OPTIONAL RFC 8707 resource identifier of the MCP server (EMA profile §4). */
  readonly resource?: string | null;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

/** Exchange an enterprise identity assertion for an ID-JAG at the IdP's token
 *  endpoint (id-jag draft §4.3).
 *
 *  The response is validated STRICTLY: an `issued_token_type` other than the
 *  id-jag URN, or a `token_type` other than `N_A`, means the IdP answered with
 *  something that is not an authorization grant. Accepting it would hand a
 *  bearer token to a Resource Authorization Server as if it were a signed
 *  assertion, so those responses fail rather than being coerced. */
export const exchangeSubjectTokenForIdJag = (
  input: ExchangeSubjectTokenForIdJagInput,
): Effect.Effect<IdJagGrant, OAuth2Error> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
          endpointUrlPolicy: input.endpointUrlPolicy,
        });
        const client: oauth.Client = { client_id: input.clientId };
        const clientAuth = pickClientAuth(
          input.clientSecret,
          input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
        );
        const params = new URLSearchParams({
          requested_token_type: ID_JAG_TOKEN_TYPE,
          audience: input.audience,
          subject_token: input.subjectToken,
          subject_token_type: input.subjectTokenType,
        });
        if (input.resource) params.set("resource", input.resource);
        if (input.scopes && input.scopes.length > 0) {
          params.set("scope", input.scopes.join(" "));
        }
        return await oauth.genericTokenEndpointRequest(
          as,
          client,
          clientAuth,
          TOKEN_EXCHANGE_GRANT_TYPE,
          params,
          oauth4webapiRequestOptions(
            input.tokenUrl,
            input.timeoutMs,
            input.endpointUrlPolicy,
            input.fetch,
          ),
        );
      },
      catch: (cause) => cause,
    }).pipe(Effect.catch(failOAuth2WithHttpSummary));

    if (!response.ok) {
      return yield* failOAuth2FromErrorResponse(response, "ID-JAG token exchange was rejected");
    }

    // Nothing else reads this body, so it is consumed directly. A read failure
    // is its own outcome: "the IdP's answer never arrived" is not the same
    // verdict as "the IdP answered with something that is not an ID-JAG".
    const text = yield* Effect.promise(() => safeBodyText(() => response.text()));
    if (text === null) {
      return yield* new OAuth2Error({
        message: "The ID-JAG token exchange response body could not be read",
      });
    }
    const parsed = yield* decodeIdJagResponse(safeJson(text)).pipe(
      Effect.mapError(
        (cause) =>
          new OAuth2Error({
            message: "ID-JAG token exchange response did not match RFC 8693 §2.2.1",
            cause,
          }),
      ),
    );
    if (parsed.issued_token_type !== ID_JAG_TOKEN_TYPE) {
      return yield* new OAuth2Error({
        message: `ID-JAG token exchange returned issued_token_type "${parsed.issued_token_type}", expected "${ID_JAG_TOKEN_TYPE}"`,
      });
    }
    if (parsed.token_type !== ID_JAG_TOKEN_TYPE_SENTINEL) {
      return yield* new OAuth2Error({
        message: `ID-JAG token exchange returned token_type "${parsed.token_type}", expected "${ID_JAG_TOKEN_TYPE_SENTINEL}"`,
      });
    }
    return {
      assertion: parsed.access_token,
      ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      ...(parsed.expires_in === undefined ? {} : { expiresIn: parsed.expires_in }),
    } satisfies IdJagGrant;
  }).pipe(
    withTokenRequestSpan({
      grantType: TOKEN_EXCHANGE_GRANT_TYPE,
      tokenUrl: input.tokenUrl,
      clientAuth: input.clientAuth,
      hasResource: input.resource != null,
    }),
  );

// ---------------------------------------------------------------------------
// RFC 7523 JWT bearer redemption — present the ID-JAG at the Resource
// Authorization Server (id-jag draft §4.4).
// ---------------------------------------------------------------------------

export type RedeemIdJagInput = {
  /** The Resource Authorization Server's token endpoint. */
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  /** The client's registration AT THE RESOURCE AUTHORIZATION SERVER. The ID-JAG's
   *  `client_id` claim names this same client (§4.4.1 client continuity). */
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly clientAuth?: ClientAuthMethod;
  readonly assertion: string;
  readonly resource?: string | null;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly endpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly fetch?: typeof globalThis.fetch;
};

/** Redeem an ID-JAG for an access token audience-restricted to the MCP server
 *  (id-jag draft §4.4). The response IS an ordinary OAuth token response, so it
 *  goes through the same processing as every other grant here. Per §4.4.3 the
 *  server SHOULD NOT issue a refresh token; when one arrives anyway it is
 *  simply not persisted — the ID-JAG chain is the renewal path. */
export const redeemIdJagAssertion = (
  input: RedeemIdJagInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl, {
        endpointUrlPolicy: input.endpointUrlPolicy,
      });
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? DEFAULT_CLIENT_AUTH_METHOD,
      );
      const params = new URLSearchParams({ assertion: input.assertion });
      if (input.resource) params.set("resource", input.resource);
      if (input.scopes && input.scopes.length > 0) {
        params.set("scope", input.scopes.join(" "));
      }
      const response = await oauth.genericTokenEndpointRequest(
        as,
        client,
        clientAuth,
        JWT_BEARER_GRANT_TYPE,
        params,
        oauth4webapiRequestOptions(
          input.tokenUrl,
          input.timeoutMs,
          input.endpointUrlPolicy,
          input.fetch,
        ),
      );
      return await processTokenEndpointResponse(as, client, response);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(failOAuth2WithHttpSummary),
    withTokenRequestSpan({
      grantType: JWT_BEARER_GRANT_TYPE,
      tokenUrl: input.tokenUrl,
      clientAuth: input.clientAuth,
      hasResource: input.resource != null,
    }),
  );

// ---------------------------------------------------------------------------
// Refresh-needed predicate
// ---------------------------------------------------------------------------

/** Whether the stored access token is close enough to its expiry to be
 *  re-minted BEFORE the next call goes out (the proactive path).
 *
 *  A null `expiresAt` means the authorization server never told us when the
 *  token dies (`expires_in` omitted from the token response). That is not the
 *  same as "never expires": the token may well be revoked or time out
 *  upstream. We deliberately do NOT refresh on every call for those — that
 *  would hammer the AS on connections whose tokens are genuinely long-lived,
 *  and there is no expiry to be "close to". Instead the reactive path owns
 *  them: an upstream 401 is the only truthful signal that an unknown-expiry
 *  token is dead, and `executor.execute` re-mints and retries once on that
 *  signal. Keep the two paths in sync — narrowing the reactive retry strands
 *  every null-expiry connection with no way to recover short of a reconnect. */
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
