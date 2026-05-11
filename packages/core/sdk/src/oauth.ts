// ---------------------------------------------------------------------------
// OAuth — core-level authorization service contract.
//
// `ctx.oauth` is the single entry point every plugin uses to mint an
// OAuth-backed `Connection`. It owns the `oauth2_session` table (pending
// authorizations), runs the strategy-specific code exchange at
// completion, and writes the resulting Connection via `ctx.connections`.
//
// Plugins supply: the resource URL they want a token for, a
// pre-decided `connectionId`, and a strategy descriptor. They get back
// an authorization URL for the user's browser; the callback reaches
// `ctx.oauth.complete`, and at invoke time the plugin calls
// `ctx.connections.accessToken(connectionId)` for a fresh Bearer.
//
// This replaces four per-plugin state machines (one each in mcp,
// openapi, google-discovery, graphql) that were all shading the same
// lifecycle.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import type { StorageFailure } from "@executor-js/storage-core";

import { ConnectionId } from "./ids";

// ---------------------------------------------------------------------------
// Strategy descriptors
//
// The strategy answers "how do we turn a resource URL + optional
// pre-configured credentials into an access token?" — separate from
// "which plugin asked?" The session row carries the strategy kind so
// completion / refresh can route without a plugin callback.
// ---------------------------------------------------------------------------

/** RFC 9728 + RFC 8414 + RFC 7591 + PKCE: discover protected-resource
 *  metadata, discover the authorization server, dynamically register a
 *  client, then PKCE-encode the authorization URL. Zero pre-configured
 *  credentials — the user just pastes a resource URL. */
export const OAuthDynamicDcrStrategy = Schema.Struct({
  kind: Schema.Literal("dynamic-dcr"),
  /** Scopes to request. Defaults to whatever `scopes_supported`
   *  advertises; caller can narrow or extend. */
  scopes: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthDynamicDcrStrategy = typeof OAuthDynamicDcrStrategy.Type;

/** RFC 6749 authorization code + PKCE with pre-configured endpoints +
 *  client_id. Used when the caller has out-of-band-registered an OAuth
 *  app (Google via Cloud Console, GitHub via developer portal, etc.) or
 *  when the auth-server URL is declared in an OpenAPI `securityScheme`. */
export const OAuthAuthorizationCodeStrategy = Schema.Struct({
  kind: Schema.Literal("authorization-code"),
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  /** Expected authorization-server issuer for ID token validation. Some
   *  providers use a token endpoint host that differs from issuer, or a
   *  path-scoped issuer such as Okta custom authorization servers. */
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /** Secret id holding the `client_id`. Using a secret row rather than
   *  an inline string so the value lives at the scope where the caller
   *  configured it and shadowing behaves consistently. */
  clientIdSecretId: Schema.String,
  /** Secret id for `client_secret`. Null for public clients using
   *  PKCE without a confidential secret. */
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  /** Separator between scopes. RFC 6749 says space; some providers
   *  (GitHub classic) use comma. */
  scopeSeparator: Schema.optional(Schema.String),
  /** Provider-specific params injected at authorization URL build time
   *  (Google's `access_type=offline`, `prompt=consent`, ...). */
  extraAuthorizationParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** `"body"` (default) sends client creds in the form body; `"basic"`
   *  uses HTTP Basic auth. Stripe-style servers require basic. */
  clientAuth: Schema.optional(Schema.Literals(["body", "basic"])),
});
export type OAuthAuthorizationCodeStrategy = typeof OAuthAuthorizationCodeStrategy.Type;

/** RFC 6749 §4.4 client credentials — no user redirect, no PKCE. Used
 *  for server-to-server integrations where the plugin has both
 *  `client_id` and `client_secret` and the server will mint tokens
 *  directly on the token endpoint. */
export const OAuthClientCredentialsStrategy = Schema.Struct({
  kind: Schema.Literal("client-credentials"),
  tokenEndpoint: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
  scopeSeparator: Schema.optional(Schema.String),
  clientAuth: Schema.optional(Schema.Literals(["body", "basic"])),
});
export type OAuthClientCredentialsStrategy = typeof OAuthClientCredentialsStrategy.Type;

/** Tagged union of every start-time strategy shape. A new strategy (e.g.
 *  device-code) is added here; the service's start/complete routes on
 *  `kind`. */
export const OAuthStrategy = Schema.Union([
  OAuthDynamicDcrStrategy,
  OAuthAuthorizationCodeStrategy,
  OAuthClientCredentialsStrategy,
]);
export type OAuthStrategy = typeof OAuthStrategy.Type;

// ---------------------------------------------------------------------------
// Provider state — what the canonical `"oauth2"` refresh handler reads
// off the Connection row. One shape regardless of originating strategy;
// only the fields needed for refresh are persisted.
// ---------------------------------------------------------------------------

/** Discriminator mirrors `OAuthStrategy["kind"]`. Refresh reads
 *  `tokenEndpoint` + `clientAuth` + client id/secret refs directly and
 *  never re-runs discovery. */
export const OAuthProviderState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("dynamic-dcr"),
    tokenEndpoint: Schema.String,
    issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
    authorizationServerUrl: Schema.optional(Schema.NullOr(Schema.String)),
    authorizationServerMetadataUrl: Schema.NullOr(Schema.String),
    idTokenSigningAlgValuesSupported: Schema.optional(Schema.Array(Schema.String)),
    /** DCR-minted client_id. Embedded inline (not a secret) — DCR
     *  clients are public-ish by design; the secret part (if the AS
     *  issued one) is a separate secret row. */
    clientId: Schema.String,
    clientSecretSecretId: Schema.NullOr(Schema.String),
    clientSecretSecretScopeId: Schema.optional(Schema.NullOr(Schema.String)),
    clientAuth: Schema.Literals(["body", "basic"]),
    scopes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
    scopeSeparator: Schema.optional(Schema.String),
    scope: Schema.NullOr(Schema.String),
    /** RFC 8707 canonical resource URL. Replayed on refresh so the new
     *  access token's audience stays bound to the same resource. */
    resource: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("authorization-code"),
    tokenEndpoint: Schema.String,
    issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
    clientIdSecretId: Schema.String,
    clientIdSecretScopeId: Schema.optional(Schema.NullOr(Schema.String)),
    clientSecretSecretId: Schema.NullOr(Schema.String),
    clientSecretSecretScopeId: Schema.optional(Schema.NullOr(Schema.String)),
    clientAuth: Schema.Literals(["body", "basic"]),
    scopes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
    scopeSeparator: Schema.optional(Schema.String),
    scope: Schema.NullOr(Schema.String),
    resource: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("client-credentials"),
    tokenEndpoint: Schema.String,
    clientIdSecretId: Schema.String,
    clientIdSecretScopeId: Schema.optional(Schema.NullOr(Schema.String)),
    clientSecretSecretId: Schema.String,
    clientSecretSecretScopeId: Schema.optional(Schema.NullOr(Schema.String)),
    scopes: Schema.Array(Schema.String),
    scopeSeparator: Schema.optional(Schema.String),
    clientAuth: Schema.Literals(["body", "basic"]),
    scope: Schema.NullOr(Schema.String),
  }),
]);
export type OAuthProviderState = typeof OAuthProviderState.Type;

/** The canonical refresh handler key. Every OAuth2-minted connection
 *  registers under this single value; the handler switches on
 *  `providerState.kind`. */
export const OAUTH2_PROVIDER_KEY = "oauth2" as const;

// ---------------------------------------------------------------------------
// Probe — "does this URL use OAuth, and if so how?"
// ---------------------------------------------------------------------------

export interface OAuthProbeInput {
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

export interface OAuthProbeResult {
  /** RFC 9728 resource metadata the server advertises, if any. */
  readonly resourceMetadata: Record<string, unknown> | null;
  readonly resourceMetadataUrl: string | null;
  /** RFC 8414 / OIDC metadata for the authorization server tied to the
   *  resource, if the server advertised one and we could fetch it. */
  readonly authorizationServerMetadata: Record<string, unknown> | null;
  readonly authorizationServerMetadataUrl: string | null;
  readonly authorizationServerUrl: string | null;
  /** True iff the AS advertises `registration_endpoint` and
   *  `token_endpoint_auth_methods_supported` includes `"none"` (public
   *  client + PKCE). A `false` value here doesn't mean OAuth is
   *  unavailable — just that the dynamic-DCR strategy can't run and the
   *  caller must fall back to `authorization-code` with user-supplied
   *  client credentials. */
  readonly supportsDynamicRegistration: boolean;
  /** True iff an unauth POST to the endpoint responded with `401` and
   *  an MCP-shaped `WWW-Authenticate: Bearer` challenge (RFC 6750).
   *  MCP-only signal; non-MCP OAuth-protected APIs usually encode auth
   *  failures inside their own protocol envelope and never surface
   *  this flag. */
  readonly isBearerChallengeEndpoint: boolean;
}

// ---------------------------------------------------------------------------
// Start / complete
// ---------------------------------------------------------------------------

export interface OAuthStartInput {
  /** Resource URL the caller wants a token for. For `dynamic-dcr` this
   *  is the probe target; for `authorization-code` it's stored only so
   *  the UI can display "signed in to X." */
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
  /** Pre-decided `Connection.id`. Writing it before the flow starts
   *  lets callers stamp `{kind:"oauth2", connectionId}` onto a source
   *  row atomically with the start call. Convention:
   *  `${pluginId}-oauth2-${namespace}`. */
  readonly connectionId: string;
  /** Scope where the resulting `Connection` + its backing secrets
   *  land. Innermost scope for per-user sign-ins. */
  readonly tokenScope: string;
  /** Redirect URL the authorization server will bounce back to. For
   *  strategies that don't redirect (`client-credentials`) pass a
   *  placeholder; it's persisted but unused. */
  readonly redirectUrl: string;
  readonly strategy: OAuthStrategy;
  /** Which plugin is initiating the flow. Persisted on the session +
   *  stamped on the minted Connection's identity label for UI. */
  readonly pluginId: string;
  /** Optional human label for the minted Connection, e.g. "Spotify OAuth". */
  readonly identityLabel?: string;
}

export interface OAuthStartResult {
  readonly sessionId: string;
  /** Present for user-interactive strategies. `null` for
   *  `client-credentials`, which skips straight to a Connection write
   *  inside `start`. */
  readonly authorizationUrl: string | null;
  /** For strategies that don't redirect, the Connection has already
   *  been minted. Surfaced so callers can stamp the source row
   *  immediately without waiting on a completion callback. */
  readonly completedConnection: { readonly connectionId: string } | null;
}

export interface OAuthCompleteInput {
  /** RFC 6749 `state` parameter — maps to a session row id. */
  readonly state: string;
  /** Optional scope check for route-scoped completions. Browser callback
   *  completions omit this because the callback URL has no scope path. */
  readonly tokenScope?: string;
  readonly code?: string;
  /** RFC 6749 `error` parameter — set when the AS redirected back with
   *  a failure. The service surfaces this as a tagged error. */
  readonly error?: string;
}

export interface OAuthCompleteResult {
  readonly connectionId: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Errors use `Schema.TaggedError` (rather than `Data.TaggedError`) so
// they can be encoded as HTTP 4xx payloads directly — every OAuth-
// capable plugin group `.addError(OAuthStartError)` etc. and the HTTP
// edge renders them with the annotated status.

export class OAuthProbeError extends Schema.TaggedErrorClass<OAuthProbeError>()(
  "OAuthProbeError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class OAuthStartError extends Schema.TaggedErrorClass<OAuthStartError>()(
  "OAuthStartError",
  {
    message: Schema.String,
    /** RFC 6749 §5.2 / RFC 7591 §3.2.2 error code propagated up from the
     *  authorization server (e.g. `invalid_client_metadata`). UI surfaces
     *  it as the structured "AS rejected the registration" reason. */
    error: Schema.optional(Schema.String),
    errorDescription: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class OAuthCompleteError extends Schema.TaggedErrorClass<OAuthCompleteError>()(
  "OAuthCompleteError",
  {
    message: Schema.String,
    /** RFC 6749 §5.2 error code, when the token endpoint returned one.
     *  Callers distinguish terminal failures (`invalid_grant` ⇒
     *  re-auth required) from transient ones. */
    code: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class OAuthSessionNotFoundError extends Schema.TaggedErrorClass<OAuthSessionNotFoundError>()(
  "OAuthSessionNotFoundError",
  {
    sessionId: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Contract — what `ctx.oauth` exposes. Implementation lives in
// `oauth-service.ts`; this file owns the stable public shape.
// ---------------------------------------------------------------------------

export interface OAuthService {
  readonly probe: (input: OAuthProbeInput) => Effect.Effect<OAuthProbeResult, OAuthProbeError>;
  readonly start: (
    input: OAuthStartInput,
  ) => Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure>;
  readonly complete: (
    input: OAuthCompleteInput,
  ) => Effect.Effect<
    OAuthCompleteResult,
    OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure
  >;
  /** Drop an in-flight session without completing — used when the
   *  user cancels the popup or the source is deleted mid-onboarding. */
  readonly cancel: (sessionId: string, tokenScope: string) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Session TTL — how long a pending authorization stays redeemable.
// 15 minutes matches every existing per-plugin implementation.
// ---------------------------------------------------------------------------

export const OAUTH2_SESSION_TTL_MS = 15 * 60 * 1000;

// Re-export ConnectionId for ergonomics — callers constructing start
// input shouldn't need to import it from two places.
export { ConnectionId };
