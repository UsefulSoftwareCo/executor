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

/** Provider error codes that Executor may record. Other provider values are dropped. */
export const OAuthProviderErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_redirect_uri",
  "invalid_client_metadata",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);
/** Response fields named by protocol validation. Values are never recorded. */
export const OAuthResponseField = Schema.Literals([
  "client_id",
  "client_secret",
  "client_secret_expires_at",
  "access_token",
  "token_type",
  "expires_in",
  "refresh_token",
  "id_token",
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "jwt_alg",
]);
/** Safe protocol evidence for diagnosis. Fixed vocabularies only; never a body, message, or URL. */
export const OAuthFailureCause = Schema.Struct({
  stage: Schema.Literals(["discover", "register", "exchange", "clientCredentials"]),
  status: Schema.optional(Schema.Int),
  providerError: Schema.optional(OAuthProviderErrorCode),
  field: Schema.optional(OAuthResponseField),
});
export type OAuthFailureCause = typeof OAuthFailureCause.Type;

/** Append safe protocol evidence to agent instructions and any report; user copy stays curated. */
const withCause = (presentation: ErrorPresentation, cause: OAuthFailureCause | undefined) => {
  if (cause === undefined) return presentation;
  const evidence = `OAuth ${cause.stage} stage${cause.status === undefined ? "" : `, HTTP ${cause.status}`}${
    cause.providerError === undefined ? "" : `, provider error ${cause.providerError}`
  }${cause.field === undefined ? "" : `, response field ${cause.field}`}.`;
  return {
    ...presentation,
    recovery: {
      ...presentation.recovery,
      instructions: `${presentation.recovery.instructions} Recorded evidence: ${evidence}`,
    },
    ...(presentation.report === undefined ? {} : { report: `${presentation.report} ${evidence}` }),
  };
};

const serviceUnavailable = {
  title: "The connected service’s sign-in is unavailable",
  description:
    "Executor could not reach this service’s sign-in. The service may be down, busy, or unreachable. This affects the service connection, not your Executor sign-in.",
  recovery: {
    action:
      "Try again in a moment. If this continues, check the service’s status or copy the fix prompt to investigate its server address.",
    instructions:
      "Inspect the current app’s provider definition and OAuth endpoints. Check reachability and service status, and distinguish a temporary outage from an incorrect endpoint. Fix incorrect configuration only when the evidence supports it; retry a temporary failure.",
  },
  retryable: true,
} satisfies ErrorPresentation;

const incompatibleResponse = {
  title: "Executor could not use the service’s response",
  description:
    "The service answered, but its response did not match what Executor expects. This is a compatibility problem between Executor and this service, not a problem with your account.",
  recovery: {
    action: "Retrying will not help. This needs a fix in Executor.",
    instructions:
      "Compare the service’s OAuth response at the recorded stage with the fields Executor and the app’s provider definition require. Identify the precise incompatibility and whether Executor or the service must change. Do not weaken state, PKCE, issuer, or token validation to work around it.",
  },
  agentFixable: false,
  report: "Incompatible OAuth response.",
} satisfies ErrorPresentation;

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
  /** Used when `clientMetadataUrl` is unset. Changing it does not replace saved clients. */
  readonly defaultClientMetadataUrl?: string;
}

/** OAuth setup failed without exposing upstream bodies, URLs containing codes, or secrets. */
export const OAuthSetupFailed = UserFacingError.define({
  tag: "OAuthSetupFailed",
  status: 422,
  fields: {
    /** Each reason has a different recovery: who must act and what they must change. */
    reason: Schema.Literals([
      "service_unavailable",
      "discovery_missing",
      "discovery_invalid",
      "discovery_blocked",
      "resource_mismatch",
      "client_not_approved",
      "registration_rejected",
      "incompatible_response",
      "invalid_client",
      "invalid_redirect",
      "token_exchange",
      "unsupported",
    ]),
    /** Executor's own public callback, which some services must approve. Forms show it with client entry. */
    callbackUrl: Schema.optional(HttpUrl),
    cause: Schema.optional(OAuthFailureCause),
  },
  presentation: ({ reason, callbackUrl, cause }) => {
    // Forms that open client entry already show the callback, so only the fix prompt repeats it.
    const callback = callbackUrl === undefined ? "" : ` Executor’s callback URL is ${callbackUrl}.`;
    return withCause(
      (
        {
          service_unavailable: serviceUnavailable,
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
          resource_mismatch: {
            title: "Server URL does not match its sign-in settings",
            description:
              "The service’s sign-in settings belong to a different address than this app’s server URL.",
            recovery: {
              action:
                "Check the app’s server URL. Copy the fix prompt into your agent to correct it.",
              instructions:
                "Compare the app’s configured server URL with the resource the service advertises in its protected-resource metadata. Update the app to use the advertised endpoint. Do not weaken resource validation.",
            },
          },
          client_not_approved: {
            title: "Service did not accept Executor",
            description:
              "This service accepts sign-in only from apps it has approved, and it has not approved Executor’s callback URL.",
            recovery: {
              action:
                "Ask the service to approve Executor’s callback URL, or create an OAuth app with the service and enter its client details.",
              instructions:
                "Identify the service’s approval or allowlist process for OAuth clients and prepare a request that includes Executor’s callback URL. If the service lets users create their own OAuth apps, explain how to create one with this callback URL and enter its client ID and secret in Executor. Do not repeatedly register clients." +
                callback,
            },
            agentFixable: false,
          },
          registration_rejected: {
            title: "Service rejected Executor’s registration",
            description: "The service refused Executor’s request to register as an OAuth client.",
            recovery: {
              action:
                "Create an OAuth app with the service and enter its client details, or copy the fix prompt to investigate.",
              instructions:
                "Compare Executor’s client registration request, including its redirect URI, grant types, token endpoint authentication method, and scopes, with the service’s registration policy. Determine whether the service needs a pre-registered client or rejects part of the request. Do not repeatedly register clients." +
                callback,
            },
          },
          incompatible_response: incompatibleResponse,
          invalid_client: {
            title: "OAuth client not accepted",
            description:
              "Executor could not use the OAuth client configuration for this connection.",
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
        } satisfies Record<typeof reason, ErrorPresentation>
      )[reason],
      cause,
    );
  },
});
/** Setup failures that a user-supplied OAuth client can resolve, so forms open client entry. */
export const oauthClientEntryReasons: ReadonlySet<OAuthSetupFailed["reason"]> = new Set([
  "invalid_client",
  "client_not_approved",
  "registration_rejected",
]);
/** Parsed OAuthSetupFailed failure. */
export type OAuthSetupFailed = typeof OAuthSetupFailed.Type;
/** Sign-in completion failed. Saved account credentials are not changed. */
export const OAuthCompletionFailed = UserFacingError.define({
  tag: "OAuthCompletionFailed",
  status: 400,
  fields: {
    /** Each reason has a different recovery. A consumed attempt always needs a new sign-in. */
    reason: Schema.Literals([
      "invalid_callback",
      "denied",
      "sign_in_expired",
      "exchange_failed",
      "invalid_client",
      "account_unavailable",
      "service_unavailable",
      "incompatible_response",
    ]),
    cause: Schema.optional(OAuthFailureCause),
  },
  presentation: ({ reason, cause }) =>
    withCause(
      (
        {
          invalid_callback: {
            title: "Sign-in response not recognised",
            description: "This sign-in response does not match a sign-in that Executor started.",
            recovery: {
              action: "Start the connection again from Executor.",
              instructions:
                "Check that the callback came from the sign-in Executor started, in the same browser session, and that the service returns to Executor’s exact callback URL. Start a fresh sign-in; never replay a callback.",
            },
          },
          denied: {
            title: "Sign-in was not approved",
            description: "The service reported that sign-in was cancelled or refused.",
            recovery: {
              action: "Start the connection again and approve access.",
              instructions:
                "Check whether the user cancelled consent or the service refused the requested scopes or account. Start a fresh sign-in after resolving the refusal.",
            },
          },
          sign_in_expired: {
            title: "Sign-in expired",
            description: "This sign-in expired or was already used.",
            recovery: {
              action: "Start the connection again.",
              instructions:
                "Start a fresh sign-in. Sign-ins expire after ten minutes and each can complete once; never replay a consumed code.",
            },
          },
          exchange_failed: {
            title: "Service rejected the sign-in",
            description: "The service refused to complete this sign-in.",
            recovery: {
              action:
                "Start the connection again. If this continues, copy the fix prompt to investigate.",
              instructions:
                "Inspect the app’s OAuth token endpoint, client authentication method, callback configuration, and requested scopes. Fix verified configuration errors and start a fresh sign-in; never replay a consumed code.",
            },
          },
          invalid_client: {
            title: "OAuth client not accepted",
            description: "The service rejected the OAuth client used for this sign-in.",
            recovery: {
              action: "Update the OAuth client details and try again.",
              instructions:
                "Compare the selected OAuth client ID, secret availability, authentication method, and redirect URL with the service’s developer settings without exposing secret values. Correct the mismatch and start a fresh sign-in.",
            },
          },
          account_unavailable: {
            title: "Account changed during sign-in",
            description:
              "The account being reconnected was removed or changed before sign-in finished.",
            recovery: {
              action: "Open Accounts and start the connection again.",
              instructions:
                "Check whether the reconnected account still exists with the same provider and sign-in method. Start a fresh connection for the intended account.",
            },
          },
          service_unavailable: {
            ...serviceUnavailable,
            recovery: {
              ...serviceUnavailable.recovery,
              action: "Start the connection again in a moment.",
            },
            retryable: false,
          },
          incompatible_response: incompatibleResponse,
        } satisfies Record<typeof reason, ErrorPresentation>
      )[reason],
      cause,
    ),
});
/** Parsed OAuthCompletionFailed failure. */
export type OAuthCompletionFailed = typeof OAuthCompletionFailed.Type;

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
