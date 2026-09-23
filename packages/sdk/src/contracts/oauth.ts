import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
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
export const OAuthSetupFailed = UserFacingError.define({
  tag: "OAuthSetupFailed",
  status: 422,
  fields: {
    reason: Schema.Literals([
      "discovery_unavailable",
      "discovery_missing",
      "discovery_invalid",
      "discovery_blocked",
      "registration",
      "invalid_client",
      "invalid_redirect",
      "token_exchange",
      "unsupported",
    ]),
  },
  presentation: ({ reason }) =>
    (
      ({
        discovery_unavailable: {
          title: "Sign-in temporarily unavailable",
          description:
            "We could not load the service’s OAuth sign-in settings. The service may be unavailable, busy, or unreachable.",
          recovery: {
            action:
              "Try again. If this continues, copy the fix prompt into your agent to check the service and connection settings.",
            instructions:
              "Inspect the current app’s provider definition and OAuth discovery URL. Check reachability and service status, and distinguish a temporary outage from an incorrect endpoint. Fix incorrect configuration only when the evidence supports it; retry a temporary failure.",
          },
          retryable: true,
        },
        discovery_missing: {
          title: "OAuth settings not found",
          description:
            "This app is configured for OAuth, but its server did not provide OAuth sign-in settings.",
          recovery: {
            action:
              "Check the app’s server URL and sign-in method. Copy the fix prompt into your agent to update the integration.",
            instructions:
              "Inspect the current app’s provider definition, server URL, and the service’s documented sign-in method. Check whether discovery targets the correct OAuth issuer. Do not disable authentication just because OAuth metadata is missing. Use No authentication only if the service documentation confirms this endpoint is public; otherwise configure its supported sign-in method.",
          },
        },
        discovery_invalid: {
          title: "OAuth settings not valid",
          description:
            "We reached the service, but its response could not be used to prepare OAuth sign-in.",
          recovery: {
            action:
              "Check the app’s OAuth server URL and configuration. Copy the fix prompt into your agent to investigate.",
            instructions:
              "Inspect the app’s provider definition and OAuth discovery configuration. Compare the discovery response with the required OAuth metadata and the service documentation. Identify an incorrect endpoint or invalid metadata, then repair the app configuration or explain the precise service-side correction needed.",
          },
        },
        discovery_blocked: {
          title: "OAuth address blocked",
          description:
            "This Executor instance does not allow access to an address in the app’s OAuth configuration.",
          recovery: {
            action:
              "Review the app’s server URL and this instance’s network policy. Copy the fix prompt into your agent to find an allowed configuration.",
            instructions:
              "Inspect the app’s OAuth discovery URL and advertised endpoints against this Executor instance’s network policy. Correct unintended or unsupported addresses. Do not bypass address validation or weaken network protections; identify the supported deployment or endpoint change needed.",
          },
        },
        registration: {
          title: "OAuth registration failed",
          description: "We could not register an OAuth client for this connection.",
          recovery: {
            action:
              "Try again. If registration still fails, copy the fix prompt into your agent to review the OAuth client setup.",
            instructions:
              "Inspect the service’s client registration support and the app’s OAuth configuration. Distinguish a temporary registration failure from a service that requires a pre-registered client. Use the supported registration or saved-client path without repeatedly creating clients.",
          },
          retryable: true,
        },
        invalid_client: {
          title: "OAuth client not accepted",
          description: "Executor could not use the OAuth client configuration for this connection.",
          recovery: {
            action:
              "Check the OAuth client settings for this service. Copy the fix prompt into your agent to find and correct the mismatch.",
            instructions:
              "Inspect which OAuth client configuration this connection selects and compare its client ID, authentication method, and redirect settings with the service’s developer settings. Check secret availability through the supported credential mechanism without exposing values. Correct the mismatch rather than replacing unrelated accounts.",
          },
        },
        invalid_redirect: {
          title: "Callback URL not valid",
          description: "Executor’s callback URL cannot be used for this sign-in.",
          recovery: {
            action:
              "Check the OAuth callback URL against the service’s settings. Copy the fix prompt into your agent to correct the mismatch.",
            instructions:
              "Compare Executor’s configured public origin and OAuth callback URL with the service’s allowed redirect URLs. Check URL validity and exact matching. Fix the relevant configuration; preserve redirect validation.",
          },
        },
        token_exchange: {
          title: "Account connection failed",
          description: "We could not complete the connection with this service.",
          recovery: {
            action:
              "Try connecting again. If this continues, copy the fix prompt into your agent to investigate the sign-in exchange.",
            instructions:
              "Inspect the app’s OAuth token endpoint, client authentication method, callback configuration, and authorization flow. Check for an expired or already-used authorization code without printing it. Fix verified configuration errors and start a fresh user sign-in when needed; never replay a consumed code.",
          },
          retryable: true,
        },
        unsupported: {
          title: "Sign-in method unavailable",
          description: "Executor cannot use this app’s OAuth sign-in configuration.",
          recovery: {
            action:
              "Review the app’s sign-in method and OAuth settings. Copy the fix prompt into your agent to use a supported configuration.",
            instructions:
              "Compare the app’s provider definition with the service’s supported OAuth flow and Executor’s supported configuration. Update the app to a documented compatible method. Do not replace required authentication with an unauthenticated connection.",
          },
        },
      }) satisfies Record<typeof reason, ErrorPresentation>
    )[reason],
});
/** Parsed OAuthSetupFailed failure. */
export type OAuthSetupFailed = typeof OAuthSetupFailed.Type;
/** The saved grant cannot supply a fresh token. Its account identity remains available for reconnection. */
export const OAuthReconnectRequired = UserFacingError.define({
  tag: "OAuthReconnectRequired",
  status: 409,
  fields: { account: AccountId },
  title: "An account needs to reconnect",
  description: "The saved sign-in can no longer be used for this account.",
  recovery: {
    action: "Open Accounts and reconnect the affected account, then return to Tools.",
    instructions:
      "Identify the selected account whose OAuth grant needs renewal. Guide the user through the supported reconnect flow for that same account. Preserve its identity and profile bindings, then verify tool discovery. Do not replace the account or switch authentication methods as a workaround.",
  },
});
/** Parsed expired or revoked account sign-in. */
export type OAuthReconnectRequired = typeof OAuthReconnectRequired.Type;

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
  id_token_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)),
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
