import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
/** Host-owned OAuth configuration and encrypted protocol records. */
import type { UrlPolicy } from "@executor-js/utils/url-policy";
import { AuthMethodName } from "./provider.ts";
import { AccountConnectionId } from "./shared.ts";
import { Schema } from "effect";
import {
  OAuthClientAuth,
  OAuthSecretClientAuth,
  OAuthTokenRequestFormat,
  OAuthTokenResponse,
} from "apps/contracts";
import { Account } from "./account.ts";
export { OAuthClientAuth } from "apps/contracts";
import type { HttpClient } from "effect/http";
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
    /** Omitted when the provider does not declare one; the client secret is then optional. */
    tokenEndpointAuthMethod: Schema.optional(OAuthClientAuth),
    /**
     * Permissions requested for the signed-in user's own token through Slack's `user_scope`
     * authorization parameter, beside `scopes`. Omitted when the provider sends none.
     */
    userScopes: Schema.optional(Schema.Array(Schema.String)),
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
export const OAuthClientUnavailable = ApiError.define({
  tag: "OAuthClientUnavailable",
  status: 409,
  fields: { provider: ProviderId, method: AuthMethodName },
  message: ({ method }) =>
    `The “${method}” OAuth method needs a client configured on this host before an account can connect.`,
  recorded: () =>
    "The OAuth method needs a client configured on this host before an account can connect",
});
export type OAuthClientUnavailable = typeof OAuthClientUnavailable.Type;

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
  "unsupported_response_type",
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
  "code_challenge_methods_supported",
  "jwt_alg",
]);
/**
 * Safe protocol evidence for diagnosis. Fixed vocabularies only; never a body, message, or URL.
 * Connections store it in recorded failures. Removing a value needs no data step: failures
 * recorded with it are left out when read (notes/oauth.md, "Failure reasons").
 */
export const OAuthFailureCause = Schema.Struct({
  stage: Schema.Literals([
    "discover",
    "register",
    "authorize",
    "exchange",
    "clientCredentials",
    "refresh",
  ]),
  status: Schema.optional(Schema.Int),
  providerError: Schema.optional(OAuthProviderErrorCode),
  field: Schema.optional(OAuthResponseField),
});
export type OAuthFailureCause = typeof OAuthFailureCause.Type;

/** The protocol evidence of a failure: closed stages, codes and fields, and the HTTP status. */
const causeEvidence = (cause: OAuthFailureCause) =>
  `OAuth ${cause.stage} stage${cause.status === undefined ? "" : `, HTTP ${cause.status}`}${
    cause.providerError === undefined ? "" : `, provider error ${cause.providerError}`
  }${cause.field === undefined ? "" : `, response field ${cause.field}`}.`;

/** What telemetry records for an OAuth failure: its kind, reason and protocol evidence. */
const oauthRecorded = (
  failure: string,
  reason: string | undefined,
  cause: OAuthFailureCause | undefined,
) =>
  `${failure}${reason === undefined ? "" : ` (${reason})`}${cause === undefined ? "" : `. ${causeEvidence(cause)}`}`;

/** The longest `error` code Executor keeps from a service's error response, in characters. */
export const maxOAuthServiceErrorLength = 128;
/**
 * The longest text Executor keeps from a service, in characters: an `error_description`, or the
 * text of an error body that is not an OAuth error. Longer text is cut short.
 */
export const maxOAuthServiceTextLength = 500;
const OAuthServiceText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maxOAuthServiceTextLength),
);
/** An RFC 6749 error response: its `error` code, including codes outside RFC 6749, and description. */
export const OAuthServiceErrorResponse = Schema.Struct({
  error: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxOAuthServiceErrorLength)),
  description: Schema.optional(OAuthServiceText),
});
/**
 * Any other error body, such as Ahrefs' JSON arrays or an HTML error page, as plain text. Markup is
 * reduced to its text, without scripts, styles or comments.
 */
export const OAuthServiceErrorBody = Schema.Struct({ body: OAuthServiceText });
/**
 * What the authorization server itself said when it refused a sign-in step. Each secret Executor
 * sent in that request, in every form the request encoded it, and any credential the text names
 * is replaced with `[redacted]`. Control characters become spaces, and the text is bounded. A 2xx
 * body is never kept unless it is an OAuth error, because it can hold tokens. It is returned to
 * callers who may manage the connection and kept on a connection's recorded failure. It never
 * enters telemetry, logs, reports, or an error's own message.
 */
export const OAuthServiceError = Schema.Union([OAuthServiceErrorResponse, OAuthServiceErrorBody]);
export type OAuthServiceError = typeof OAuthServiceError.Type;

/**
 * Append safe protocol evidence to agent instructions and any report; user copy stays curated.
 * The service's own words are shown beside it, labelled as its response.
 */
const withCause = (
  presentation: ErrorPresentation,
  cause: OAuthFailureCause | undefined,
  serviceError?: OAuthServiceError,
): ErrorPresentation => withServiceError(withProtocolCause(presentation, cause), serviceError);

const withProtocolCause = (
  presentation: ErrorPresentation,
  cause: OAuthFailureCause | undefined,
) => {
  if (cause === undefined) return presentation;
  const evidence = causeEvidence(cause);
  return {
    ...presentation,
    recovery: {
      ...presentation.recovery,
      instructions: `${presentation.recovery.instructions} Recorded evidence: ${evidence}`,
    },
    ...(presentation.report === undefined ? {} : { report: `${presentation.report} ${evidence}` }),
  };
};

/**
 * Show the service's own words beside the curated explanation, labelled as its response. They
 * stay out of the title, description, and recovery text, and out of any public report.
 */
const withServiceError = (
  presentation: ErrorPresentation,
  serviceError: OAuthServiceError | undefined,
): ErrorPresentation =>
  serviceError === undefined
    ? presentation
    : {
        ...presentation,
        detail: {
          label: "Service response",
          value: Schema.is(OAuthServiceErrorBody)(serviceError)
            ? serviceError.body
            : serviceError.description === undefined
              ? serviceError.error
              : `${serviceError.error}: ${serviceError.description}`,
        },
      };

const serviceUnavailable = {
  title: "The connected service’s sign-in is unavailable",
  description: "Executor couldn’t reach the service, which may be down or busy.",
  recovery: {
    action: "Try again in a moment, or check the service’s status if this continues.",
    instructions:
      "Inspect the current app’s provider definition and OAuth endpoints. Check reachability and service status, and distinguish a temporary outage from an incorrect endpoint. Fix incorrect configuration only when the evidence supports it; retry a temporary failure.",
  },
  retryable: true,
} satisfies ErrorPresentation;

/**
 * With `rate_limited`, the time the service's Retry-After header named, when it sent one. Other
 * reasons never carry it.
 */
const RetryAfter = Schema.optional(Schema.Date);

/**
 * A Retry-After time as copy: rounded up to the minute and written in UTC, so the server, the
 * browser and an agent reading a recorded failure all show the same words, never too early.
 */
const retryTime = (at: Date) => {
  const minute = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  const month = minute.getUTCMonth() * 3;
  const clock = [minute.getUTCHours(), minute.getUTCMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${clock} UTC on ${minute.getUTCDate()} ${"JanFebMarAprMayJunJulAugSepOctNovDec".slice(month, month + 3)} ${minute.getUTCFullYear()}`;
};

/**
 * HTTP 429 from the service: Executor reached it, and it is limiting requests. The recovery names
 * the time the service gave in Retry-After, or says to try again shortly when it gave none.
 */
const rateLimited = (
  retryAfter: Date | undefined,
  copy: {
    readonly description: string;
    /** The next step, completed with when to take it. */
    readonly action: string;
    readonly instructions: string;
  },
): ErrorPresentation => ({
  title: "Service rate limit reached",
  description: copy.description,
  recovery: {
    action:
      retryAfter === undefined
        ? `${copy.action} shortly.`
        : `${copy.action} after ${retryTime(retryAfter)}.`,
    instructions: `The service answered HTTP 429 Too Many Requests: Executor reached it, and it is limiting requests. ${
      retryAfter === undefined
        ? "It did not say how long to wait, so retry after a short pause."
        : `Its Retry-After header asked Executor to wait until ${retryAfter.toISOString()}, so retry only after that.`
    } ${copy.instructions} Do not retry in a loop, and do not change the app’s OAuth configuration or replace accounts for this failure. If it continues, check the service’s documented rate limits for its OAuth endpoints.`,
  },
  agentFixable: false,
});

const incompatibleResponse = {
  title: "Executor could not use the service’s response",
  description:
    "This is a compatibility problem between Executor and the service, not a problem with your account.",
  recovery: {
    action: "Retrying won’t help until Executor is fixed.",
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
  /**
   * A fixed prefix for every sign-in's OAuth `state`, so a proxy in front of a shared callback
   * URL can tell this host's callbacks apart without a lookup. The random part is unchanged.
   */
  readonly statePrefix?: string;
}

/**
 * OAuth setup failed without exposing upstream bodies, URLs containing codes, or secrets. The
 * service's own error, when it sent one, is kept apart in `serviceError`.
 */
export const OAuthSetupFailed = UserFacingError.define({
  tag: "OAuthSetupFailed",
  status: 422,
  fields: {
    /**
     * Each reason has a different recovery: who must act and what they must change. Stored in
     * connections' recorded failures, like the cause; a reason the reading release does not know,
     * because a later release removed it or an earlier one predates it, hides failures recorded with it.
     */
    reason: Schema.Literals([
      "service_unavailable",
      "rate_limited",
      "discovery_missing",
      "discovery_invalid",
      "discovery_blocked",
      "resource_mismatch",
      "client_not_approved",
      "client_registration_required",
      "client_metadata_rejected",
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
    serviceError: Schema.optional(OAuthServiceError),
    retryAfter: RetryAfter,
  },
  recorded: ({ reason, cause }) => oauthRecorded("OAuth setup failed", reason, cause),
  presentation: ({ reason, callbackUrl, cause, serviceError, retryAfter }) => {
    // Forms that open client entry already show the callback, so only the fix prompt repeats it.
    const callback = callbackUrl === undefined ? "" : ` Executor’s callback URL is ${callbackUrl}.`;
    return withCause(
      (
        {
          service_unavailable: serviceUnavailable,
          rate_limited: {
            ...rateLimited(retryAfter, {
              description:
                "The service asked Executor to wait before sending more sign-in requests.",
              action: "Try again",
              instructions:
                "Starting the sign-in again needs no change to the app or its OAuth client.",
            }),
            retryable: true,
          },
          discovery_missing: {
            title: "OAuth settings not found",
            description: "This app uses OAuth, but its server doesn’t say how to sign in.",
            recovery: {
              action: "Check the app’s server URL and sign-in method.",
              instructions:
                "Inspect the current app’s provider definition, server URL, and the service’s documented sign-in method. Check whether discovery targets the correct OAuth issuer. Do not disable authentication just because OAuth metadata is missing. Use No authentication only if the service documentation confirms this endpoint is public; otherwise configure its supported sign-in method.",
            },
          },
          discovery_invalid: {
            title: "OAuth settings not valid",
            description: "The service answered, but what it sent is incomplete or malformed.",
            recovery: {
              action: "Check the app’s OAuth server URL and configuration.",
              instructions:
                "Inspect the app’s provider definition and OAuth discovery configuration. Compare the discovery response with the required OAuth metadata and the service documentation. Identify an incorrect endpoint or invalid metadata, then repair the app configuration or explain the precise service-side correction needed.",
            },
          },
          discovery_blocked: {
            title: "OAuth address blocked",
            description:
              "This Executor instance doesn’t allow requests to an address in the app’s OAuth settings.",
            recovery: {
              action: "Review the app’s server URL and this instance’s network policy.",
              instructions:
                "Inspect the app’s OAuth discovery URL and advertised endpoints against this Executor instance’s network policy. Correct unintended or unsupported addresses. Do not bypass address validation or weaken network protections; identify the supported deployment or endpoint change needed.",
            },
          },
          resource_mismatch: {
            title: "Server URL does not match its sign-in settings",
            description:
              "The service says its sign-in belongs to another address, so Executor won’t use it.",
            recovery: {
              action: "Check the app’s server URL.",
              instructions:
                "Compare the app’s configured server URL with the resource the service advertises in its protected-resource metadata. Update the app to use the advertised endpoint. Do not weaken resource validation.",
            },
          },
          // RFC 7591 section 3.2.2: registration itself failed, so no client exists yet.
          client_not_approved: {
            title: "Callback URL refused during registration",
            description: "This service doesn’t accept Executor’s callback URL.",
            recovery: {
              action:
                "Create an OAuth app there with this redirect URL and enter its client ID and secret, or ask the service to allow it.",
              instructions:
                "Executor’s dynamic client registration request was refused with invalid_redirect_uri (RFC 7591 section 3.2.2): the service does not accept Executor’s callback URL as a redirect URI. Read the service’s response, when one is shown, for the rule it applies. If the service lets users create their own OAuth apps, explain how to create one with this callback URL and enter its client ID and secret in Executor. Otherwise identify the service’s approval or allowlist process and prepare a request that includes Executor’s callback URL. Do not repeatedly register clients." +
                callback,
            },
            agentFixable: false,
          },
          // RFC 7591 lets a registration endpoint require an initial access token. Executor has
          // none, so a 401 or 403 there means the service registers clients only by hand.
          client_registration_required: {
            title: "Automatic registration not allowed",
            description: "This service only accepts OAuth apps created in its developer settings.",
            recovery: {
              action:
                "Create an OAuth app there with this redirect URL, then enter its client ID and secret.",
              instructions:
                "The service’s dynamic client registration endpoint requires authorization, such as an RFC 7591 initial access token, which Executor does not have. Explain how to create an OAuth client in the service’s developer settings with Executor’s callback URL, then enter its client ID and secret in Executor. Do not repeatedly register clients or ask for the service’s registration credentials." +
                callback,
            },
            agentFixable: false,
          },
          // RFC 7591 section 3.2.2. Cloudflare Access returns it for a callback URL outside
          // its allowed redirect URIs; with grant types matched to the server's metadata, that
          // allowlist is the likeliest cause.
          client_metadata_rejected: {
            title: "Service did not accept Executor’s callback URL",
            description:
              "Executor’s callback URL is most likely not among the service’s allowed redirect URIs.",
            recovery: {
              action:
                "Ask the service’s administrator to allow it, or create an OAuth app there and enter its client ID and secret.",
              instructions:
                "The registration endpoint returned invalid_client_metadata (RFC 7591 section 3.2.2). Services with a redirect URI allowlist, such as Cloudflare Access, return it when the callback URL is not allowed. Check the service’s allowed redirect URIs for Executor’s callback URL first, then compare the other registered fields: grant types, response types, token endpoint authentication method and scopes. Do not repeatedly register clients." +
                callback,
            },
            agentFixable: false,
          },
          registration_rejected: {
            title: "Service rejected Executor’s registration",
            description: "Without an OAuth client for this service, Executor can’t start sign-in.",
            recovery: {
              action:
                "Create an OAuth app there with this redirect URL and enter its client ID and secret, or copy the fix prompt to investigate.",
              instructions:
                "Compare Executor’s client registration request, including its redirect URI, grant types, token endpoint authentication method, and scopes, with the service’s registration policy. Determine whether the service needs a pre-registered client or rejects part of the request. Do not repeatedly register clients." +
                callback,
            },
          },
          incompatible_response: incompatibleResponse,
          invalid_client: {
            title: "OAuth client not accepted",
            description:
              "The client ID, secret or authentication method doesn’t match what the service expects.",
            recovery: {
              action:
                "Check the client in the service’s developer settings, then enter its current details.",
              instructions:
                "Inspect which OAuth client configuration this connection selects and compare its client ID, authentication method, and redirect settings with the service’s developer settings. Check secret availability through the supported credential mechanism without exposing values. Correct the mismatch rather than replacing unrelated accounts.",
            },
          },
          invalid_redirect: {
            title: "Callback URL not valid",
            description: "Executor’s callback URL is malformed or not allowed on this instance.",
            recovery: {
              action: "Check this Executor instance’s public address.",
              instructions:
                "Compare Executor’s configured public origin and OAuth callback URL with the service’s allowed redirect URLs. Check URL validity and exact matching. Fix the relevant configuration; preserve redirect validation.",
            },
          },
          token_exchange: {
            title: "Account connection failed",
            description:
              "Executor couldn’t get an access token from the service for this OAuth client.",
            recovery: {
              action: "Try connecting again, or copy the fix prompt if this continues.",
              instructions:
                "Inspect the app’s OAuth token endpoint, client authentication method, callback configuration, and authorization flow. Check for an expired or already-used authorization code without printing it. Fix verified configuration errors and start a fresh user sign-in when needed; never replay a consumed code.",
            },
            retryable: true,
          },
          unsupported: {
            title: "Sign-in method unavailable",
            description: "Executor doesn’t support the OAuth setup this app or service uses.",
            recovery: {
              action: "Review the app’s sign-in method and OAuth settings.",
              instructions:
                "Compare the app’s provider definition with the service’s supported OAuth flow and Executor’s supported configuration. Update the app to a documented compatible method. Do not replace required authentication with an unauthenticated connection.",
            },
          },
        } satisfies Record<typeof reason, ErrorPresentation>
      )[reason],
      cause,
      serviceError,
    );
  },
});
/** Setup failures that a user-supplied OAuth client can resolve, so forms open client entry. */
export const oauthClientEntryReasons: ReadonlySet<OAuthSetupFailed["reason"]> = new Set([
  "invalid_client",
  "client_not_approved",
  "client_registration_required",
  "client_metadata_rejected",
  "registration_rejected",
]);
/** Parsed OAuthSetupFailed failure. */
export type OAuthSetupFailed = typeof OAuthSetupFailed.Type;
/**
 * Every way sign-in completion can fail. Each reason names one cause, so recovery never guesses.
 * Stored in connections' recorded failures; a reason the reading release does not know hides
 * failures recorded with it.
 */
export const OAuthCompletionReason = Schema.Literals([
  // Executor matches the callback to the sign-in it started.
  "callback_malformed",
  "sign_in_not_found",
  "sign_in_replaced",
  "redirect_mismatch",
  "sign_in_expired",
  "sign_in_used",
  "account_unavailable",
  // The service's authorization response, validated before its `error` is read.
  "issuer_mismatch",
  "denied",
  "invalid_scope",
  "invalid_client",
  "authorization_rejected",
  // The token exchange.
  "authorization_code_rejected",
  "registered_client_rejected",
  "registered_client_incompatible",
  "exchange_failed",
  "destination_blocked",
  "service_unavailable",
  "rate_limited",
  "incompatible_response",
  "unsupported",
  "oauth_unavailable",
]);
export type OAuthCompletionReason = typeof OAuthCompletionReason.Type;

const restart = (
  presentation: Omit<ErrorPresentation, "recovery"> & { readonly instructions: string },
): ErrorPresentation => ({
  title: presentation.title,
  description: presentation.description,
  recovery: { action: "Start the connection again.", instructions: presentation.instructions },
  agentFixable: false,
});

/** Sign-in completion failed. Saved account credentials are not changed. */
export const OAuthCompletionFailed = UserFacingError.define({
  tag: "OAuthCompletionFailed",
  status: 400,
  fields: {
    /** A consumed attempt always needs a new sign-in. */
    reason: OAuthCompletionReason,
    cause: Schema.optional(OAuthFailureCause),
    serviceError: Schema.optional(OAuthServiceError),
    retryAfter: RetryAfter,
  },
  recorded: ({ reason, cause }) => oauthRecorded("Sign-in completion failed", reason, cause),
  presentation: ({ reason, cause, serviceError, retryAfter }) =>
    withCause(
      (
        {
          callback_malformed: restart({
            title: "Sign-in response not recognised",
            description:
              "The service sent the browser back to Executor with an incomplete or altered address.",
            instructions:
              "The callback URL had no single valid state value, or carried a fragment or credentials. Start a fresh sign-in from Executor; never replay or edit a callback URL.",
          }),
          sign_in_not_found: restart({
            title: "Sign-in not found",
            description:
              "Executor has no record of this sign-in, which may have started at another Executor address.",
            instructions:
              "No pending sign-in matches the callback's state. The sign-in may have started on another Executor instance or origin. Start a fresh sign-in from the Executor instance that should own the account; never replay a callback.",
          }),
          sign_in_replaced: restart({
            title: "Sign-in replaced",
            description: "A newer sign-in for this connection started, possibly in another tab.",
            instructions:
              "Only the latest sign-in for a connection can complete. Finish the newest sign-in or start a fresh one; never replay a callback.",
          }),
          redirect_mismatch: {
            title: "Sign-in returned to a different address",
            description: "A proxy or the service may have changed the callback URL Executor sent.",
            recovery: {
              action: "Check Executor’s public address and the service’s allowed redirect URLs.",
              instructions:
                "Compare the callback URL Executor registered for this sign-in with the address the browser returned to, including origin, path and query parameters. Check the instance’s public origin and any proxy or relay rewriting the callback. Preserve exact redirect matching.",
            },
          },
          sign_in_expired: restart({
            title: "Sign-in expired",
            description: "This sign-in took longer than ten minutes to finish.",
            instructions: "Sign-ins expire after ten minutes. Start a fresh sign-in.",
          }),
          sign_in_used: restart({
            title: "Sign-in already used",
            description: "This sign-in may have already finished in another tab.",
            instructions:
              "Each sign-in can complete once. Check Accounts for an account the other completion created, or start a fresh sign-in; never replay a callback.",
          }),
          account_unavailable: {
            title: "Account changed during sign-in",
            description:
              "The account being reconnected was removed or edited, so nothing was saved.",
            recovery: {
              action: "Open the app’s Accounts tab and reconnect the account again.",
              instructions:
                "Check whether the reconnected account still exists with the same provider and sign-in method. Start a fresh connection for the intended account.",
            },
            agentFixable: false,
          },
          issuer_mismatch: {
            title: "Service identified itself differently",
            description:
              "The service’s sign-in response didn’t name the issuer the app’s OAuth settings expect.",
            recovery: {
              action: "Check the app’s OAuth issuer settings.",
              instructions:
                "Compare the issuer the app's provider definition declares, or the issuer its discovery URL publishes, with the service's documented issuer. Prefer the service's discovery document, or declare its exact issuer alongside explicit endpoints. Do not disable issuer validation (RFC 9207).",
            },
          },
          denied: {
            title: "Sign-in was cancelled",
            description: "Access was not approved on the service’s sign-in page.",
            recovery: {
              action: "Start the connection again and approve access.",
              instructions:
                "The service returned access_denied: the user cancelled consent, or the service refused access for this account. Start a fresh sign-in after resolving the refusal.",
            },
            agentFixable: false,
          },
          invalid_scope: {
            title: "Requested access not accepted",
            description: "The service doesn’t allow some of the permissions the app asks for.",
            recovery: {
              action: "Check the app’s requested scopes.",
              instructions:
                "Compare the scopes the app’s provider definition requests with the scopes the service documents and advertises for this client. Remove or correct unknown or unavailable scopes, then start a fresh sign-in. Do not request broader access to work around the refusal.",
            },
          },
          invalid_client: {
            title: "OAuth client not accepted",
            description:
              "The client ID, secret or authentication method doesn’t match what the service expects.",
            recovery: {
              action: "Update the OAuth client details and try again.",
              instructions:
                "Compare the selected OAuth client ID, secret availability, authentication method, and redirect URL with the service’s developer settings without exposing secret values. Correct the mismatch and start a fresh sign-in.",
            },
          },
          authorization_rejected: {
            title: "Service rejected the sign-in request",
            description:
              "The service’s sign-in page found a problem in the request built from the app’s OAuth settings.",
            recovery: {
              action: "Check the app’s OAuth settings.",
              instructions:
                "The service returned an authorization error other than access_denied, invalid_scope or a client rejection. Compare the app's declared authorization parameters, response type and endpoints with the service's documentation, then start a fresh sign-in.",
            },
          },
          registered_client_rejected: restart({
            title: "Service rejected Executor’s client",
            description:
              "The service no longer accepts the client Executor registered earlier, so a new sign-in registers a fresh one.",
            instructions:
              "The token endpoint answered invalid_client for a client Executor registered in an earlier sign-in and reused. Executor removed that saved registration, so the next sign-in registers a fresh client. If the fresh client is rejected too, the failure is reported as registered_client_incompatible.",
          }),
          registered_client_incompatible: {
            title: "Service rejected a new Executor client",
            description:
              "The service refused the client Executor registered moments ago, so trying again would fail the same way.",
            recovery: {
              action: "Copy the fix prompt for your agent to find out why.",
              instructions:
                "The token endpoint answered invalid_client for a client Executor registered moments earlier in the same sign-in. Executor discarded it. Compare the client authentication method Executor registered, and how it sends the client ID and secret, with what the service's token endpoint accepts. Check the service's registration response for a different token_endpoint_auth_method. Do not ask the user for client details; the client was never theirs.",
            },
          },
          authorization_code_rejected: restart({
            title: "Service rejected the sign-in code",
            description: "The code from this sign-in may have expired or already been used.",
            instructions:
              "The token endpoint returned invalid_grant. Start a fresh sign-in; never replay a consumed code. If it repeats, compare the redirect URI and PKCE handling with the service's requirements.",
          }),
          exchange_failed: {
            title: "Service rejected the sign-in",
            description: "The service wouldn’t exchange the sign-in code for access.",
            recovery: {
              action: "Check the app’s OAuth settings.",
              instructions:
                "Inspect the app’s OAuth token endpoint, client authentication method, callback configuration, and requested scopes. Fix verified configuration errors and start a fresh sign-in; never replay a consumed code.",
            },
          },
          destination_blocked: {
            title: "OAuth address blocked",
            description:
              "This Executor instance doesn’t allow requests to the service’s token endpoint.",
            recovery: {
              action: "Review the app’s OAuth endpoints and this instance’s network policy.",
              instructions:
                "Inspect the app's token endpoint against this Executor instance's network policy. Correct unintended addresses. Do not bypass address validation or weaken network protections.",
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
          // The sign-in was claimed before the token request, so only a new one can finish.
          rate_limited: rateLimited(retryAfter, {
            description: "The service asked Executor to wait before sending more sign-in requests.",
            action: "Start the connection again",
            instructions:
              "The token endpoint refused the code exchange for now, and this sign-in has ended: start a fresh one, and never replay the callback.",
          }),
          incompatible_response: incompatibleResponse,
          unsupported: {
            title: "Sign-in method unavailable",
            description: "The service issued a kind of access token that Executor can’t use.",
            recovery: {
              action:
                "Retrying won’t help unless the service can issue standard access tokens for this app.",
              instructions:
                "Check the recorded response field. Executor sends access tokens as Bearer tokens and cannot create DPoP proofs (RFC 9449). Determine whether the service can issue Bearer tokens for this client, and configure that if it can. Do not strip sender constraints from tokens to work around it.",
            },
            agentFixable: false,
          },
          oauth_unavailable: {
            title: "OAuth sign-in unavailable",
            description: "This Executor instance isn’t configured for OAuth.",
            recovery: {
              action: "Ask the instance administrator to enable OAuth sign-in.",
              instructions:
                "The host was started without OAuth transport options. Check the instance configuration that supplies OAuth support.",
            },
            agentFixable: false,
          },
        } satisfies Record<OAuthCompletionReason, ErrorPresentation>
      )[reason],
      cause,
      serviceError,
    ),
});
/**
 * What the person finishing sign-in can do next, for every completion reason:
 * - `restart`: start the same connection again.
 * - `client`: the service rejected the OAuth client; correct its details.
 * - `configuration`: retrying will not help until the app or instance changes.
 * - `account`: the account being reconnected changed; start again from the app's Accounts tab.
 * - `cancelled`: the user declined; nothing is wrong.
 */
export type OAuthCompletionRecovery =
  | "restart"
  | "client"
  | "configuration"
  | "account"
  | "cancelled";
export const oauthCompletionRecovery = {
  callback_malformed: "restart",
  sign_in_not_found: "restart",
  sign_in_replaced: "restart",
  redirect_mismatch: "configuration",
  sign_in_expired: "restart",
  sign_in_used: "restart",
  account_unavailable: "account",
  issuer_mismatch: "configuration",
  denied: "cancelled",
  invalid_scope: "configuration",
  invalid_client: "client",
  authorization_rejected: "configuration",
  authorization_code_rejected: "restart",
  registered_client_rejected: "restart",
  registered_client_incompatible: "configuration",
  exchange_failed: "configuration",
  destination_blocked: "configuration",
  service_unavailable: "restart",
  rate_limited: "restart",
  incompatible_response: "configuration",
  unsupported: "configuration",
  oauth_unavailable: "configuration",
} as const satisfies Record<OAuthCompletionReason, OAuthCompletionRecovery>;
/** Parsed OAuthCompletionFailed failure. */
export type OAuthCompletionFailed = typeof OAuthCompletionFailed.Type;

/**
 * The saved grant cannot supply a fresh token. Its account identity remains available for
 * reconnection. `cause` is present when the token endpoint refused a renewal.
 */
export const OAuthReconnectRequired = UserFacingError.define({
  tag: "OAuthReconnectRequired",
  status: 409,
  fields: {
    account: AccountId,
    /**
     * `renewal_interrupted`: an earlier renewal stopped with its process before saving a result,
     * and the service refused the saved refresh token when it was retried, most likely because
     * the lost renewal had already replaced it.
     */
    reason: Schema.optional(Schema.Literals(["renewal_interrupted"])),
    cause: Schema.optional(OAuthFailureCause),
  },
  recorded: ({ reason, cause }) => oauthRecorded("An account needs to reconnect", reason, cause),
  presentation: ({ reason, cause }) =>
    withCause(
      {
        title: "An account needs to reconnect",
        description:
          reason === "renewal_interrupted"
            ? "Executor stopped while renewing this account’s access, before it could save the result. The service no longer accepts the saved sign-in, most likely because that renewal had already replaced it."
            : "The saved sign-in can no longer be used for this account.",
        recovery: {
          action:
            "Open the app’s Accounts tab and reconnect the affected account, then return to Tools.",
          instructions:
            "Identify the selected account whose OAuth grant needs renewal. Guide the user through the supported reconnect flow for that same account. Preserve its identity and profile bindings, then verify tool discovery. Do not replace the account or switch authentication methods as a workaround.",
        },
      },
      cause,
    ),
});
/** Parsed expired or revoked account sign-in. */
export type OAuthReconnectRequired = typeof OAuthReconnectRequired.Type;

/**
 * Renewing a saved grant failed without the service saying the grant has ended. The grant,
 * including its refresh token, is kept unchanged, and the next use renews it again.
 */
export const OAuthRenewalFailed = UserFacingError.define({
  tag: "OAuthRenewalFailed",
  status: 502,
  fields: {
    account: AccountId,
    /**
     * `service_unavailable`: an outage or temporary refusal. `rate_limited`: HTTP 429, the
     * service limiting requests. `incompatible_response`: a response Executor could not use.
     * `client_rejected`: the service refused the OAuth client itself (`invalid_client`,
     * `unauthorized_client`, or a 401 client-authentication challenge), which says nothing about
     * this account's grant. `renewal_rejected`: any other OAuth error, including codes outside
     * RFC 6749, which also does not say the grant has ended.
     */
    reason: Schema.Literals([
      "service_unavailable",
      "rate_limited",
      "incompatible_response",
      "client_rejected",
      "renewal_rejected",
    ]),
    cause: Schema.optional(OAuthFailureCause),
    retryAfter: RetryAfter,
  },
  recorded: ({ reason, cause }) =>
    oauthRecorded("Renewing an account's access failed", reason, cause),
  presentation: ({ reason, cause, retryAfter }) =>
    withCause(
      (
        {
          rate_limited: {
            ...rateLimited(retryAfter, {
              description:
                "The service is limiting requests to renew this account’s access right now. The saved sign-in is kept, so the account does not need to reconnect.",
              action: "Try again",
              instructions:
                "The account’s saved OAuth grant, including its refresh token, is intact; do not reconnect, delete or replace the account. Retrying the operation renews the grant again.",
            }),
            retryable: true,
          },
          service_unavailable: {
            ...serviceUnavailable,
            description:
              "Executor could not renew this account’s access because the service’s sign-in is down, busy, or unreachable. The saved sign-in is kept, so the account does not need to reconnect.",
            recovery: {
              action: "Try again in a moment. If this continues, check the service’s status.",
              instructions:
                "The account’s saved OAuth grant is intact; do not reconnect or replace the account for this failure. Check the service’s status and the reachability of the token endpoint recorded in the app’s provider definition, and distinguish a temporary outage from an incorrect endpoint. Retry a temporary failure; fix incorrect configuration only when the evidence supports it.",
            },
          },
          incompatible_response: {
            ...incompatibleResponse,
            description:
              "The service answered Executor’s request to renew this account’s access, but its response did not match what Executor expects. The saved sign-in is kept; this is a compatibility problem, not a problem with your account.",
          },
          client_rejected: {
            title: "The service rejected Executor’s OAuth client",
            description:
              "The service refused the OAuth client Executor uses to renew this account’s access. This is a problem with the client configuration, not with the account’s sign-in, which is kept.",
            recovery: {
              action:
                "Check the OAuth client ID and secret at the service. If they changed, reconnect the account and enter the current client details.",
              instructions:
                "The account’s saved OAuth grant is intact; do not delete or replace the account. Compare the client ID, secret and token endpoint authentication method recorded for this provider with the service’s client configuration. If the secret was rotated or the client removed, reconnect this same account with the current client details. If the configuration is correct, the fault is in how Executor authenticates the client; report it rather than reconnecting.",
            },
          },
          renewal_rejected: {
            title: "The service refused to renew this account’s access",
            description:
              "The service refused Executor’s request to renew this account’s access without saying the sign-in has ended. The saved sign-in is kept, and Executor tries again the next time the account is used.",
            recovery: {
              action:
                "Try again in a moment. If this continues, reconnect the account from the app’s Accounts tab.",
              instructions:
                "The account’s saved OAuth grant is intact. Inspect the recorded provider error code and HTTP status. Retry a temporary refusal. If the service keeps refusing, reconnect this same account; do not replace the account or change its authentication method.",
            },
            retryable: true,
          },
        } satisfies Record<typeof reason, ErrorPresentation>
      )[reason],
      cause,
    ),
});
/** Parsed failed renewal that kept the saved grant. */
export type OAuthRenewalFailed = typeof OAuthRenewalFailed.Type;

/** Registration and attempt IDs also bind encrypted data to the record which owns it. */
export const OAuthClientId = Schema.NonEmptyString.pipe(Schema.brand("OAuthClientId"));
export type OAuthClientId = typeof OAuthClientId.Type;
export const OAuthAttemptId = Schema.NonEmptyString.pipe(Schema.brand("OAuthAttemptId"));
export type OAuthAttemptId = typeof OAuthAttemptId.Type;

/** Validated subset of authorization-server metadata used for saved grants. */
export const OAuthTokenServer = Schema.Struct({
  /**
   * Microsoft identity platform's multi-tenant metadata publishes a `{tenantid}` template here;
   * each ID token's `iss` is that template with the token's own `tid` claim substituted.
   */
  issuer: HttpUrl,
  /**
   * The provider declared endpoints without an issuer. Executor derives `issuer` from the token
   * URL to key saved clients, but it is not the service's identifier, so callbacks are not checked against it.
   */
  issuer_derived: Schema.optional(Schema.Literal(true)),
  authorization_endpoint: Schema.optional(HttpUrl),
  token_endpoint: HttpUrl,
  registration_endpoint: Schema.optional(HttpUrl),
  /** RFC 7009 endpoint. Optional so grants saved before it was retained still decode. */
  revocation_endpoint: Schema.optional(HttpUrl),
  jwks_uri: Schema.optional(HttpUrl),
  id_token_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)),
  authorization_response_iss_parameter_supported: Schema.optional(Schema.Boolean),
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  /** RFC 8414 grant types. Registration requests only advertised ones when present. */
  grant_types_supported: Schema.optional(Schema.Array(Schema.String)),
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
  /** Ahrefs lists its scopes under this name instead of RFC 9728's `scopes_supported`. */
  scopes_provided: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthResource = typeof OAuthResource.Type;

/**
 * Where protected-resource metadata was read, in the order MCP clients look: the document a
 * Bearer challenge names, else the path-suffixed well-known URL, then the root one (RFC 9728).
 */
export const ResourceMetadataLocation = Schema.Literals(["challenge", "path", "root"]);
export type ResourceMetadataLocation = typeof ResourceMetadataLocation.Type;
/**
 * How a client is obtained at an authorization server, in MCP's order of preference: a Client ID
 * Metadata Document, dynamic client registration (RFC 7591), or a client the user registers.
 */
export const OAuthClientRegistration = Schema.Literals([
  "client_id_metadata_document",
  "dynamic",
  "manual",
]);
export type OAuthClientRegistration = typeof OAuthClientRegistration.Type;
/** One protected-resource metadata lookup and what it found, without its URL or body. */
export const ResourceMetadataSignal = Schema.TaggedStruct("ResourceMetadata", {
  location: ResourceMetadataLocation,
  status: Schema.optionalKey(Schema.Int),
  result: Schema.Literals(["found", "missing", "invalid", "mismatch", "blocked", "unavailable"]),
});
export type ResourceMetadataSignal = typeof ResourceMetadataSignal.Type;
/** The authorization server's RFC 8414 or OpenID Connect metadata, without its URL or body. */
export const AuthorizationServerSignal = Schema.TaggedStruct("AuthorizationServerMetadata", {
  /** Named by the resource metadata, or the MCP server's origin when it publishes none. */
  issuer: Schema.Literals(["resource_metadata", "origin"]),
  status: Schema.optionalKey(Schema.Int),
  result: Schema.Literals(["found", "missing", "invalid", "blocked", "unavailable", "unsupported"]),
  /** The document that answered: RFC 8414 metadata or OpenID Connect Discovery. */
  document: Schema.optionalKey(Schema.Literals(["oauth", "openid"])),
  registration: Schema.optionalKey(OAuthClientRegistration),
});
export type AuthorizationServerSignal = typeof AuthorizationServerSignal.Type;
export const ResourceOAuthSignal = Schema.Union([
  ResourceMetadataSignal,
  AuthorizationServerSignal,
]);
export type ResourceOAuthSignal = typeof ResourceOAuthSignal.Type;
/**
 * What a protected resource advertises about authorization-code OAuth, and the lookups that
 * decided it. Unusable OAuth names the step that failed; it never selects another method.
 */
export const ResourceOAuth = Schema.TaggedUnion({
  OAuthNotAdvertised: { signals: Schema.Array(ResourceOAuthSignal) },
  OAuthAdvertised: {
    registration: OAuthClientRegistration,
    signals: Schema.Array(ResourceOAuthSignal),
  },
  OAuthUnusable: {
    reason: Schema.Literals([
      "unavailable",
      "metadata_missing",
      "invalid",
      "resource_mismatch",
      "blocked",
      "unsupported",
    ]),
    signals: Schema.Array(ResourceOAuthSignal),
  },
});
export type ResourceOAuth = typeof ResourceOAuth.Type;
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
/**
 * How a client came to exist. Only a `registered` client is Executor's to discard and replace;
 * saved records written before sources were recorded have none. A `metadata` client is the
 * host's client metadata document and is not saved; only earlier versions saved one.
 */
export const OAuthClientSource = Schema.Literals(["registered", "metadata", "manual"]);
export type OAuthClientSource = typeof OAuthClientSource.Type;
/** Read beside the registration from the same encrypted saved-client record. */
export const OAuthSavedClientMetadata = Schema.Struct({
  executor_source: Schema.optionalKey(OAuthClientSource),
});
/**
 * A saved client as one attempt used it. `version` is the stored ciphertext in base64; every
 * save re-encrypts, so a conditional delete removes only the record this attempt saw.
 */
export const OAuthSavedClientRef = Schema.Struct({
  key: OAuthClientId,
  version: Schema.NonEmptyString,
  source: Schema.optionalKey(OAuthClientSource),
  /** Registered by this attempt's own start, rather than reused from an earlier one. */
  fresh: Schema.Boolean,
});
/** Protocol context frozen when authorization starts, preventing callback-supplied identity changes. */
export const OAuthAttempt = Schema.Struct({
  connection: AccountConnectionId,
  account: AccountId,
  owner: OwnerId,
  provider: ProviderId,
  method: Schema.NonEmptyString,
  /** Absent when the account is named after sign-in. */
  label: Schema.optionalKey(Schema.String),
  reconnect: Schema.optional(Schema.Boolean),
  redirectUri: HttpUrl,
  state: Schema.NonEmptyString,
  verifier: Schema.NonEmptyString,
  nonce: Schema.optional(Schema.NonEmptyString),
  server: OAuthServer,
  client: OAuthRegistration,
  /** User-entered clients become reusable only when this attempt completes successfully. */
  clientKey: Schema.optionalKey(OAuthClientId),
  /** The saved client this attempt used, so a rejection can discard exactly that version. */
  savedClient: Schema.optionalKey(OAuthSavedClientRef),
  resource: Schema.optional(HttpUrl),
  /** Token request encoding and nested grant location, as the provider declared them. */
  tokenRequestFormat: Schema.optional(OAuthTokenRequestFormat),
  tokenResponse: Schema.optional(OAuthTokenResponse),
  response: JsonObject,
});
export type OAuthAttempt = typeof OAuthAttempt.Type;
/** Private refresh context. Access-token projections are stored separately on the account. */
const grantFields = {
  resource: Schema.optional(HttpUrl),
  /**
   * Token request encoding frozen at sign-in, so renewal sends what the service accepted. Grants
   * saved before it was retained use the form encoding.
   */
  tokenRequestFormat: Schema.optional(OAuthTokenRequestFormat),
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
    /** The first validated ID token's `sub`. A refreshed ID token must keep it (OIDC Core §12.2). */
    idTokenSubject: Schema.optional(Schema.NonEmptyString),
    /**
     * The first validated ID token's `iss`, saved with its `sub` because a subject is only unique
     * at its issuer. A refreshed ID token must keep it too. It differs from `server.issuer` only
     * for a Microsoft `{tenantid}` template, where each token names its own tenant. Grants saved
     * before this field keep a fixed server issuer, which every ID token must already match.
     */
    idTokenIssuer: Schema.optional(Schema.NonEmptyString),
    /** Nested grant location frozen at sign-in; renewals read the same member. */
    tokenResponse: Schema.optional(OAuthTokenResponse),
  }),
  Schema.Struct({
    ...grantFields,
    grant: Schema.Literal("client_credentials"),
    server: OAuthTokenServer,
    client: OAuthConfidentialRegistration,
    scopes: Schema.Array(Schema.String),
    /** Joins `scopes` on each exchange. Grants saved before it was retained use a space. */
    scopeSeparator: Schema.optional(Schema.NonEmptyString),
  }),
]);
export type OAuthGrant = typeof OAuthGrant.Type;
