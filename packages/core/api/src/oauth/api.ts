// ---------------------------------------------------------------------------
// OAuth HTTP API — the v2 OAuth surface.
//
// OAuth is a credential mechanism, not an integration type. A `createClient`
// registers an owner-scoped app (its own endpoints + client id/secret); `start`
// runs that client's flow to mint a Connection for one integration; `complete`
// exchanges the authorization code; `cancel` drops an in-flight session;
// `probe` discovers an authorization-server's metadata for the onboarding UI.
//
// NOTE(v2): `start`/`complete` are STUBBED in the SDK (milestone 2) — the routes
// are wired to call them but will fail at runtime until the flow is implemented.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  InternalError,
  OAuthClientSlug,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAuthState,
  Owner,
  ProviderKey,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Shared connection projection (start "connected" / complete results).
// ---------------------------------------------------------------------------

const ConnectionResponse = Schema.Struct({
  owner: Owner,
  name: ConnectionName,
  integration: IntegrationSlug,
  template: AuthTemplateSlug,
  provider: ProviderKey,
  address: ConnectionAddress,
  identityLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  // The OAuth app (`oauth_client` slug) that minted this connection — these
  // results always come from an OAuth flow, so it is non-null in practice. Just
  // a slug, never a secret; kept consistent with the connections-list shape.
  oauthClient: Schema.NullOr(OAuthClientSlug),
  oauthClientOwner: Schema.NullOr(Owner),
  oauthScope: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// createClient — register an owner-scoped OAuth app.
// ---------------------------------------------------------------------------

const CreateClientPayload = Schema.Struct({
  owner: Owner,
  slug: OAuthClientSlug,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  grant: Schema.Literals(["authorization_code", "client_credentials"]),
  clientId: Schema.String,
  clientSecret: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
});

const CreateClientResponse = Schema.Struct({
  client: OAuthClientSlug,
});

// ---------------------------------------------------------------------------
// registerDynamic — RFC 7591 Dynamic Client Registration. The server mints the
// client id (and possibly a client secret); the user pastes NOTHING. The payload
// deliberately carries NO clientId/clientSecret, and the response is the slug
// only — the minted secret is never returned over the wire.
// ---------------------------------------------------------------------------

const RegisterDynamicPayload = Schema.Struct({
  owner: Owner,
  slug: OAuthClientSlug,
  registrationEndpoint: Schema.String,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientName: Schema.optional(Schema.String),
  redirectUri: Schema.optional(Schema.NullOr(Schema.String)),
  originIntegration: Schema.optional(Schema.NullOr(IntegrationSlug)),
});

const RegisterDynamicResponse = Schema.Struct({
  client: OAuthClientSlug,
});

// ---------------------------------------------------------------------------
// listClients — metadata-only summaries of the clients visible to the caller
// (their org's shared clients + their own user clients). The `clientSecret` is
// NEVER part of this projection.
// ---------------------------------------------------------------------------

const OAuthClientSummaryResponse = Schema.Struct({
  owner: Owner,
  slug: OAuthClientSlug,
  grant: Schema.Literals(["authorization_code", "client_credentials"]),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  clientId: Schema.String,
  origin: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("manual") }),
    Schema.Struct({
      kind: Schema.Literal("dynamic_client_registration"),
      integration: Schema.optional(Schema.NullOr(IntegrationSlug)),
    }),
  ]),
});

const ListClientsResponse = Schema.Array(OAuthClientSummaryResponse);

// ---------------------------------------------------------------------------
// removeClient — permanently delete an owner-scoped OAuth app. The app is keyed
// by (owner, slug) — the slug alone is not globally unique — so the slug is a
// path param and the owner is in the payload (mirrors the policies/connections
// delete shape). Idempotent: removing an already-gone app still returns
// `{ removed: true }`. Connections that referenced the slug are NOT cascaded;
// they keep their stored value and fail at the next token refresh.
// ---------------------------------------------------------------------------

const RemoveClientParams = { slug: OAuthClientSlug };

const RemoveClientPayload = Schema.Struct({
  owner: Owner,
});

const RemoveClientResponse = Schema.Struct({
  removed: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// start — run a client's flow to mint a connection for one integration. The
// status discriminates "connected" (inline, e.g. client_credentials) from
// "redirect" (user must visit the authorization URL).
// ---------------------------------------------------------------------------

const StartPayload = Schema.Struct({
  client: OAuthClientSlug,
  /** The owner of `client` (a Personal connection may use a shared Workspace app). */
  clientOwner: Owner,
  owner: Owner,
  name: ConnectionName,
  integration: IntegrationSlug,
  template: AuthTemplateSlug,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optional(Schema.NullOr(Schema.String)),
});

const StartResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    connection: ConnectionResponse,
  }),
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: OAuthState,
  }),
]);

// ---------------------------------------------------------------------------
// complete — exchange the authorization code, mint the connection.
// ---------------------------------------------------------------------------

const CompletePayload = Schema.Struct({
  state: OAuthState,
  code: Schema.String,
  /** Regional host echoed back by the authorization server (Datadog's
   *  `domain`/`site`); forwarded so the code is redeemed at the org's region. */
  callbackDomain: Schema.optional(Schema.NullOr(Schema.String)),
});

// ---------------------------------------------------------------------------
// cancel — drop an in-flight session without exchanging.
// ---------------------------------------------------------------------------

const CancelPayload = Schema.Struct({
  state: OAuthState,
});

const CancelResponse = Schema.Struct({
  cancelled: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// probe — discover an authorization-server's metadata.
// ---------------------------------------------------------------------------

const ProbePayload = Schema.Struct({
  url: Schema.String,
});

const ProbeResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopesSupported: Schema.optional(Schema.Array(Schema.String)),
  registrationEndpoint: Schema.optional(Schema.NullOr(Schema.String)),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientIdMetadataDocumentSupported: Schema.optional(Schema.Boolean),
});

// ---------------------------------------------------------------------------
// callback — GET with `state` + `code` (or `error`) query params. Renders the
// popup HTML directly; the popup script posts the completion result back to the
// opener via `postMessage` / `BroadcastChannel`.
// ---------------------------------------------------------------------------

const CallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
  // Non-standard region hints (Datadog: `domain` is a bare host, `site` a full
  // origin). Captured so the token exchange can target the org's region.
  domain: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
});

const HtmlResponse = Schema.String.pipe(HttpApiSchema.asText());

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const OAuthStart = OAuthStartError.annotate({ httpApiStatus: 400 });
const OAuthComplete = OAuthCompleteError.annotate({ httpApiStatus: 400 });
const OAuthProbe = OAuthProbeError.annotate({ httpApiStatus: 400 });
const OAuthRegisterDynamic = OAuthRegisterDynamicError.annotate({ httpApiStatus: 400 });
const OAuthSessionNotFound = OAuthSessionNotFoundError.annotate({ httpApiStatus: 404 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const OAuthApi = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("createClient", "/oauth/clients", {
      payload: CreateClientPayload,
      success: CreateClientResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("registerDynamic", "/oauth/clients/register-dynamic", {
      payload: RegisterDynamicPayload,
      success: RegisterDynamicResponse,
      error: [InternalError, OAuthRegisterDynamic],
    }),
  )
  .add(
    HttpApiEndpoint.get("listClients", "/oauth/clients", {
      success: ListClientsResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeClient", "/oauth/clients/:slug", {
      params: RemoveClientParams,
      payload: RemoveClientPayload,
      success: RemoveClientResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("start", "/oauth/start", {
      payload: StartPayload,
      success: StartResponse,
      error: [InternalError, OAuthStart],
    }),
  )
  .add(
    HttpApiEndpoint.post("complete", "/oauth/complete", {
      payload: CompletePayload,
      success: ConnectionResponse,
      error: [InternalError, OAuthComplete, OAuthSessionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/oauth/cancel", {
      payload: CancelPayload,
      success: CancelResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("probe", "/oauth/probe", {
      payload: ProbePayload,
      success: ProbeResponse,
      error: [InternalError, OAuthProbe],
    }),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/callback", {
      query: CallbackUrlParams,
      success: HtmlResponse,
      error: [InternalError, OAuthComplete, OAuthSessionNotFound],
    }),
  );
