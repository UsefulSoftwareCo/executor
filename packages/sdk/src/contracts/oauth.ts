/** Host-owned OAuth configuration and encrypted protocol records. */
import type { UrlPolicy } from "@executor-js/utils/url-policy";
import { AuthMethodName } from "./provider.ts";
import { AccountConnectionId } from "./shared.ts";
import { Schema } from "effect";
import { OAuthClientAuth, OAuthSecretClientAuth } from "apps/contracts";
import { Account } from "./account.ts";
export { OAuthClientAuth } from "apps/contracts";
import type { HttpClient } from "effect/unstable/http";
import { AccountId, HttpUrl, JsonObject, OwnerId, ProviderId } from "./shared.ts";

/** A sign-in URL and its expiry. No account exists until completion succeeds. */
export const OAuthSignIn = Schema.Struct({
  authorizationUrl: HttpUrl,
  expiresAt: Schema.Date,
});

export type OAuthSignIn = typeof OAuthSignIn.Type;

/** Authorization code needs a redirect; client credentials completes the same connection immediately. */
export const OAuthStartResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("redirect"), ...OAuthSignIn.fields }),
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
]);
export type OAuthStartResult = typeof OAuthStartResult.Type;

const clientSetup = {
  mode: Schema.Literals(["automatic", "saved", "client-required"]),
  scopes: Schema.Array(Schema.String),
};
/** Safe form metadata resolved from provider code and discovery. Never contains saved client IDs or secrets. */
export const OAuthClientSetup = Schema.Union([
  Schema.Struct({
    ...clientSetup,
    grant: Schema.Literal("authorization_code"),
    tokenEndpointAuthMethod: OAuthClientAuth,
  }),
  Schema.Struct({
    ...clientSetup,
    grant: Schema.Literal("client_credentials"),
    tokenEndpointAuthMethod: OAuthSecretClientAuth,
  }),
]);
export type OAuthClientSetup = typeof OAuthClientSetup.Type;
/** Inspect the client configuration for one owner, provider, method, and callback. */
export const CheckOAuthSetup = Schema.Struct({
  owner: OwnerId,
  provider: ProviderId,
  method: AuthMethodName,
  redirectUri: Schema.optional(HttpUrl),
});

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
      "invalid_client",
      "account_unavailable",
    ]),
  },
  {
    httpApiStatus: 400,
    description: "OAuth completion failed. Saved account credentials were not changed.",
  },
) {}

/** User-supplied client configuration. A client secret is write-only at API boundaries. */
export const OAuthClientInput = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
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
      "token_exchange",
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
export const OAuthTokenServer = Schema.Struct({
  issuer: HttpUrl,
  authorization_endpoint: Schema.optional(HttpUrl),
  token_endpoint: HttpUrl,
  registration_endpoint: Schema.optional(HttpUrl),
  jwks_uri: Schema.optional(HttpUrl),
  authorization_response_iss_parameter_supported: Schema.optional(Schema.Boolean),
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthTokenServer = typeof OAuthTokenServer.Type;
/** Browser grants require an authorization endpoint as well as a token endpoint. */
export const OAuthServer = Schema.Struct({
  ...OAuthTokenServer.fields,
  authorization_endpoint: HttpUrl,
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
/** A secret-bearing client suitable for machine grants and confidential browser clients. */
export const OAuthConfidentialRegistration = Schema.Struct({
  ...registration,
  token_endpoint_auth_method: OAuthSecretClientAuth,
  client_secret: Schema.NonEmptyString,
});
export type OAuthConfidentialRegistration = typeof OAuthConfidentialRegistration.Type;
export const OAuthRegistration = Schema.Union([
  Schema.Struct({ ...registration, token_endpoint_auth_method: Schema.Literal("none") }),
  OAuthConfidentialRegistration,
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
  /** User-entered clients become reusable only when this attempt completes successfully. */
  clientKey: Schema.optionalKey(OAuthClientId),
  resource: Schema.optional(HttpUrl),
  response: JsonObject,
});
export type OAuthAttempt = typeof OAuthAttempt.Type;
/** Private refresh context. Access-token projections are stored separately on the account. */
const grantFields = {
  resource: Schema.optional(HttpUrl),
  response: JsonObject,
  expiresAt: Schema.optional(Schema.Number),
  fields: JsonObject,
};
/** Private renewal context; machine grants retain scopes and exchange client credentials again. */
export const OAuthGrant = Schema.Union([
  Schema.Struct({
    ...grantFields,
    grant: Schema.optionalKey(Schema.Literal("authorization_code")),
    server: OAuthServer,
    client: OAuthRegistration,
    refreshToken: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    ...grantFields,
    grant: Schema.Literal("client_credentials"),
    server: OAuthTokenServer,
    client: OAuthConfidentialRegistration,
    scopes: Schema.Array(Schema.String),
  }),
]);
export type OAuthGrant = typeof OAuthGrant.Type;
