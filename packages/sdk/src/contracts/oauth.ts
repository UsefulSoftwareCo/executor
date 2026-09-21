/** Host-owned OAuth configuration and encrypted protocol records. */
import type { UrlPolicy } from "@executor-js/utils/url-policy";
import { AuthMethodName } from "./provider.ts";
import { AccountConnectionId } from "./shared.ts";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { AccountId, HttpUrl, JsonObject, OwnerId, ProviderId } from "./shared.ts";

/** A sign-in URL and its expiry. No account exists until completion succeeds. */
export const OAuthSignIn = Schema.Struct({
  authorizationUrl: HttpUrl,
  expiresAt: Schema.Date,
});

export type OAuthSignIn = typeof OAuthSignIn.Type;

/** The host cannot resolve an approved OAuth client for this provider method. */
export class OAuthClientUnavailable extends Schema.TaggedError<OAuthClientUnavailable>()(
  "OAuthClientUnavailable",
  { provider: ProviderId, method: AuthMethodName },
  {
    httpApiStatus: 409,
    description: "OAuth client configuration is required on the trusted host.",
  },
) {}

/** Safe failure categories; no callback URL, code, state, or upstream body. */
export class OAuthCompletionFailed extends Schema.TaggedError<OAuthCompletionFailed>()(
  "OAuthCompletionFailed",
  {
    reason: Schema.Literals([
      "invalid_callback",
      "expired",
      "denied",
      "already_completed",
      "exchange_failed",
      "account_unavailable",
    ]),
  },
  {
    httpApiStatus: 400,
    description: "OAuth completion failed. Saved account credentials were not changed.",
  },
) {}

/** How the trusted host authenticates a client at the token endpoint. */
export const OAuthClientAuth = Schema.Literals([
  "none",
  "client_secret_post",
  "client_secret_basic",
]);
/** User-supplied client configuration. A client secret is write-only at API boundaries. */
export const OAuthClientInput = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
  tokenEndpointAuthMethod: OAuthClientAuth,
});
export type OAuthClientInput = typeof OAuthClientInput.Type;

/** Network transport and client identity belong to the product hosting this SDK. */
export interface OAuthOptions {
  readonly httpClient: HttpClient.HttpClient;
  readonly clientName: string;
  /** Host transport policy for callbacks, discovery and every token request. */
  readonly urlPolicy: UrlPolicy;
  readonly clientMetadataUrl?: string;
}

/** OAuth setup failed without exposing upstream bodies, URLs containing codes, or secrets. */
export class OAuthSetupFailed extends Schema.TaggedError<OAuthSetupFailed>()(
  "OAuthSetupFailed",
  {
    reason: Schema.Literals([
      "discovery",
      "registration",
      "invalid_client",
      "invalid_redirect",
      "unsupported",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    return `OAuth setup failed: ${this.reason}`;
  }
}
/** The saved grant cannot supply a fresh token. Its account identity remains available for reconnection. */
export class OAuthReconnectRequired extends Schema.TaggedError<OAuthReconnectRequired>()(
  "OAuthReconnectRequired",
  {
    account: AccountId,
  },
  { httpApiStatus: 409 },
) {}

/** Registration and attempt IDs also bind encrypted data to the record which owns it. */
export const OAuthClientId = Schema.NonEmptyString.pipe(Schema.brand("OAuthClientId"));
export type OAuthClientId = typeof OAuthClientId.Type;
export const OAuthAttemptId = Schema.NonEmptyString.pipe(Schema.brand("OAuthAttemptId"));
export type OAuthAttemptId = typeof OAuthAttemptId.Type;

/** Validated subset of authorization-server metadata used for saved grants. */
export const OAuthServer = Schema.Struct({
  issuer: HttpUrl,
  authorization_endpoint: HttpUrl,
  token_endpoint: HttpUrl,
  registration_endpoint: Schema.optional(HttpUrl),
  jwks_uri: Schema.optional(HttpUrl),
  authorization_response_iss_parameter_supported: Schema.optional(Schema.Boolean),
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthServer = typeof OAuthServer.Type;
/** The protected resource owns its canonical identifier and authorization-server list. */
export const OAuthResource = Schema.Struct({
  resource: HttpUrl,
  authorization_servers: Schema.Array(HttpUrl),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});
/** This record is only read inside encrypted host state; never return it to app code. */
const registration = {
  client_id: Schema.NonEmptyString,
  client_secret_expires_at: Schema.optional(Schema.Number),
};
export const OAuthRegistration = Schema.Union([
  Schema.Struct({ ...registration, token_endpoint_auth_method: Schema.Literal("none") }),
  Schema.Struct({
    ...registration,
    token_endpoint_auth_method: Schema.Literals(["client_secret_basic", "client_secret_post"]),
    client_secret: Schema.NonEmptyString,
  }),
]);
export type OAuthRegistration = typeof OAuthRegistration.Type;
/** Protocol context frozen when authorization starts, preventing callback-supplied identity changes. */
export const OAuthAttempt = Schema.Struct({
  connection: AccountConnectionId,
  account: AccountId,
  owner: OwnerId,
  provider: ProviderId,
  method: Schema.NonEmptyString,
  label: Schema.String,
  reconnect: Schema.optional(Schema.Boolean),
  redirectUri: HttpUrl,
  state: Schema.NonEmptyString,
  verifier: Schema.NonEmptyString,
  nonce: Schema.optional(Schema.NonEmptyString),
  server: OAuthServer,
  client: OAuthRegistration,
  resource: Schema.optional(HttpUrl),
  response: JsonObject,
});
export type OAuthAttempt = typeof OAuthAttempt.Type;
/** Private refresh context. Access-token projections are stored separately on the account. */
export const OAuthGrant = Schema.Struct({
  server: OAuthServer,
  client: OAuthRegistration,
  resource: Schema.optional(HttpUrl),
  response: JsonObject,
  refreshToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.optional(Schema.Number),
  fields: JsonObject,
});
export type OAuthGrant = typeof OAuthGrant.Type;
