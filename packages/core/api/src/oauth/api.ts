// ---------------------------------------------------------------------------
// Shared OAuth HTTP API — one endpoint set per flow, served at
// `/scopes/:scopeId/oauth/{probe,start,complete,callback}` for every
// plugin that needs OAuth. `pluginId` lives on the request body so the
// completion callback can route to the right plugin at persist time.
// Replaces the four per-plugin copies that lived under
// `/scopes/:scopeId/{mcp,openapi,graphql,google-discovery}/oauth/*`.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAuthStrategySchema,
  ScopeId,
  SecretBackedMap,
} from "@executor-js/sdk";

import { InternalError } from "../observability";

const ScopeParams = { scopeId: ScopeId };
// ---------------------------------------------------------------------------
// Probe — decide between dynamic-DCR and paste-your-credentials flows
// ---------------------------------------------------------------------------

const ProbePayload = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
});

const ProbeResponse = Schema.Struct({
  resourceMetadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerMetadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  authorizationServerMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  supportsDynamicRegistration: Schema.Boolean,
  isBearerChallengeEndpoint: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Start — persists an `oauth2_session` row; for user-interactive flows
// returns an authorization URL, for `client-credentials` mints the
// Connection inline and returns it under `completedConnection`.
// ---------------------------------------------------------------------------

const StartPayload = Schema.Struct({
  /** Resource URL — used by probe/display, not by the start flow for
   *  static strategies. */
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
  /** Where the authorization server will bounce the user's browser
   *  back to. Pass a placeholder (e.g. the token URL) for flows that
   *  don't redirect; the service still persists it. */
  redirectUrl: Schema.String,
  /** Stable id the Connection the exchange will mint. Caller typically
   *  derives this as `${pluginId}-oauth2-${namespace}` so the source
   *  row can be stamped atomically with the flow start. */
  connectionId: Schema.String,
  /** Scope where the resulting Connection + its backing secrets land. */
  tokenScope: Schema.String,
  strategy: OAuthStrategySchema,
  /** Which plugin is initiating the flow. Persisted on the session +
   *  stamped on the minted Connection's identity-label prefix. */
  pluginId: Schema.String,
  /** Human label for the minted Connection. */
  identityLabel: Schema.optional(Schema.String),
});

const StartResponse = Schema.Struct({
  sessionId: Schema.String,
  /** Present for user-interactive strategies. `null` for
   *  `client-credentials` (no redirect). */
  authorizationUrl: Schema.NullOr(Schema.String),
  /** Filled for strategies that mint the Connection inline. */
  completedConnection: Schema.NullOr(Schema.Struct({ connectionId: Schema.String })),
});

// ---------------------------------------------------------------------------
// Complete — exchange the code, mint the Connection, drop the session.
// ---------------------------------------------------------------------------

const CompletePayload = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const CompleteResponse = Schema.Struct({
  connectionId: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// Cancel — drop an in-flight session without exchanging.
// ---------------------------------------------------------------------------

const CancelPayload = Schema.Struct({
  sessionId: Schema.String,
  /** Scope that owns the pending OAuth session. Must match start.tokenScope. */
  tokenScope: Schema.String,
});

const CancelResponse = Schema.Struct({
  cancelled: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// OAuth callback — GET with `state` + `code` (or `error`) query params.
// Renders the popup HTML directly; the popup script posts the completion
// result back to the opener via `postMessage` / `BroadcastChannel`.
// ---------------------------------------------------------------------------

const CallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = Schema.String.pipe(HttpApiSchema.asText());

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const OAuthApi = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("probe", "/scopes/:scopeId/oauth/probe", {
      params: ScopeParams,
      payload: ProbePayload,
      success: ProbeResponse,
      error: [InternalError, OAuthProbeError],
    }),
  )
  .add(
    HttpApiEndpoint.post("start", "/scopes/:scopeId/oauth/start", {
      params: ScopeParams,
      payload: StartPayload,
      success: StartResponse,
      error: [InternalError, OAuthStartError],
    }),
  )
  .add(
    HttpApiEndpoint.post("complete", "/scopes/:scopeId/oauth/complete", {
      params: ScopeParams,
      payload: CompletePayload,
      success: CompleteResponse,
      error: [InternalError, OAuthCompleteError, OAuthSessionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/scopes/:scopeId/oauth/cancel", {
      params: ScopeParams,
      payload: CancelPayload,
      success: CancelResponse,
      error: [InternalError, OAuthSessionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/callback", {
      query: CallbackUrlParams,
      success: HtmlResponse,
      error: [InternalError, OAuthCompleteError, OAuthSessionNotFoundError],
    }),
  );
