import type { Effect } from "effect";
import { Schema } from "effect";

import type { Connection } from "./connection";
import type { StorageFailure } from "./fuma-runtime";
import {
  type AuthTemplateSlug,
  type ConnectionName,
  type IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  type Owner,
} from "./ids";

/* The v2 OAuth surface contracts. OAuth is a credential mechanism, not an
 * integration type. A client is a registered app; running its flow mints a
 * Connection. The client is self-contained (carries its own endpoints) and
 * integration-independent, so the same app can back connections on whatever
 * integrations share that provider.
 *
 * The OAuth 2.1 *implementation* (PKCE, DCR, token exchange + refresh) lives in
 * `oauth-helpers` / `oauth-discovery` / `oauth-service`; these are the public
 * input/output shapes the executor's `oauth.*` namespace speaks. */

export type OAuthGrant = "authorization_code" | "client_credentials";

/** Provider OAuth config an integration declares as one of its auth templates —
 *  what to request. (The flow itself runs off the self-contained OAuthClient.) */
export interface OAuthAuthentication {
  readonly slug: AuthTemplateSlug;
  readonly type: "oauth";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
}

/** A registered OAuth app — pure app identity: clientId/secret + its endpoints.
 *  Owner-scoped: a shared org app or a user's own BYO app. The app does NOT carry
 *  scopes — what to request is the INTEGRATION's concern (`OAuthAuthentication.
 *  scopes`, surfaced via the declared auth method), so the same app can back any
 *  integration without pinning a scope set. */
export interface OAuthClient {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly grant: OAuthGrant;
  readonly clientId: string;
  /** The literal client secret. Stored out-of-band in the credential provider
   *  (vault item id), never inline. Empty string for public / PKCE clients. */
  readonly clientSecret: string;
  /** RFC 8707 Resource Indicator (MCP). Carried so the refresh request can keep
   *  the re-minted token bound to the same resource. Null/omitted otherwise. */
  readonly resource?: string | null;
}

export type CreateOAuthClientInput = OAuthClient;

/** Metadata-only projection of a registered client for listing in the UI.
 *  Deliberately omits `clientSecret` — the secret is never returned over the
 *  read surface. `clientId` is included (it is not a secret; it is sent in the
 *  authorize URL the user's browser visits). */
export interface OAuthClientSummary {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly grant: OAuthGrant;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly clientId: string;
}

/** Flow-aware result of `oauth.start` — the status says what's next. */
export type ConnectResult =
  | { readonly status: "connected"; readonly connection: Connection }
  | {
      readonly status: "redirect";
      readonly authorizationUrl: string;
      readonly state: OAuthState;
    };

/** Start a flow through a client to mint a connection for one integration.
 *  `template` is the integration's oauth template the minted token is applied
 *  through. */
export interface OAuthStartInput {
  readonly client: OAuthClientSlug;
  /** The owner that owns `client`. Supplied explicitly (the picker knows it), so
   *  a Personal connection can be minted through a shared Workspace app without
   *  any owner-derivation rule. A Workspace connection must use a Workspace app. */
  readonly clientOwner: Owner;
  /** The owner the minted CONNECTION is saved under (may differ from `clientOwner`). */
  readonly owner: Owner;
  readonly name: ConnectionName;
  readonly integration: IntegrationSlug;
  readonly template: AuthTemplateSlug;
  readonly identityLabel?: string | null;
  /** Browser-facing callback URL for this flow. Defaults to the executor's configured redirectUri. */
  readonly redirectUri?: string | null;
}

export interface OAuthCompleteInput {
  readonly state: OAuthState;
  readonly code: string;
}

/** Probe a base/issuer URL for OAuth 2.1 authorization-server metadata so the
 *  onboarding UI can pre-fill a client's endpoints. */
export interface OAuthProbeInput {
  readonly url: string;
}

export interface OAuthProbeResult {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** RFC 8707 resource indicator discovered from protected-resource metadata.
   *  Persist this on DCR clients so authorize/token/refresh requests stay bound
   *  to the protected resource. */
  readonly resource?: string | null;
  readonly scopesSupported?: readonly string[];
  /** Whether the server advertises dynamic client registration (RFC 7591). */
  readonly registrationEndpoint?: string | null;
  /** RFC 8414 `token_endpoint_auth_methods_supported`. Surfaced so DCR can pick
   *  a public ("none") client when the server allows it. */
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
}

/** Mint an OAuth client via RFC 7591 Dynamic Client Registration and persist it.
 *  The user pastes NO client id/secret — the authorization server mints a
 *  (public, PKCE) client which is stored as an owner-scoped `oauth_client`. */
export interface RegisterDynamicClientInput {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  /** RFC 7591 registration endpoint advertised by the authorization server. */
  readonly registrationEndpoint: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopes: readonly string[];
  /** Auth methods the server advertises. When it allows `none` a public
   *  (PKCE-only, no secret) client is registered; otherwise `client_secret_post`. */
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  /** Human label for the registered app (RFC 7591 `client_name`). */
  readonly clientName?: string;
  /** Browser-facing callback URL to register. Defaults to the executor's configured redirectUri. */
  readonly redirectUri?: string | null;
}

export class OAuthStartError extends Schema.TaggedErrorClass<OAuthStartError>()("OAuthStartError", {
  message: Schema.String,
}) {}

export class OAuthCompleteError extends Schema.TaggedErrorClass<OAuthCompleteError>()(
  "OAuthCompleteError",
  {
    message: Schema.String,
    /** True when the auth-code exchange failed in a way the user must restart. */
    restartRequired: Schema.optional(Schema.Boolean),
  },
) {}

export class OAuthProbeError extends Schema.TaggedErrorClass<OAuthProbeError>()("OAuthProbeError", {
  message: Schema.String,
}) {}

export class OAuthRegisterDynamicError extends Schema.TaggedErrorClass<OAuthRegisterDynamicError>()(
  "OAuthRegisterDynamicError",
  { message: Schema.String },
) {}

export class OAuthSessionNotFoundError extends Schema.TaggedErrorClass<OAuthSessionNotFoundError>()(
  "OAuthSessionNotFoundError",
  { state: OAuthState },
) {}

/** The OAuth surface the executor's `oauth.*` namespace and `ctx.oauth` expose.
 *  Implemented by `makeOAuthService` (oauth-service.ts), wired by the executor
 *  with the deps it needs to mint connections. */
export interface OAuthService {
  readonly createClient: (
    input: CreateOAuthClientInput,
  ) => Effect.Effect<OAuthClientSlug, StorageFailure>;
  /** Mint a client via RFC 7591 Dynamic Client Registration (no pre-shared
   *  client id/secret) and persist it as an owner-scoped `oauth_client`. */
  readonly registerDynamicClient: (
    input: RegisterDynamicClientInput,
  ) => Effect.Effect<OAuthClientSlug, OAuthRegisterDynamicError | StorageFailure>;
  /** All registered clients visible to the caller (their org's shared clients +
   *  their own user clients), as metadata-only summaries — never the secret. */
  readonly listClients: () => Effect.Effect<readonly OAuthClientSummary[], StorageFailure>;
  /** Permanently remove a registered OAuth app, keyed by (owner, slug). The
   *  owner policy on `oauth_client` prevents removing another subject's user app.
   *  Idempotent: removing an already-gone app succeeds. Connections that
   *  referenced the slug keep their stored value and fail at the next token
   *  refresh, prompting a reconnect — this op never cascades into connections. */
  readonly removeClient: (
    owner: Owner,
    slug: OAuthClientSlug,
  ) => Effect.Effect<void, StorageFailure>;
  readonly start: (
    input: OAuthStartInput,
  ) => Effect.Effect<ConnectResult, OAuthStartError | StorageFailure>;
  readonly complete: (
    input: OAuthCompleteInput,
  ) => Effect.Effect<Connection, OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure>;
  readonly cancel: (state: OAuthState) => Effect.Effect<void, StorageFailure>;
  readonly probe: (
    input: OAuthProbeInput,
  ) => Effect.Effect<OAuthProbeResult, OAuthProbeError | StorageFailure>;
}
