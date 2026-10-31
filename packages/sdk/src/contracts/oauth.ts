import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { ApiError } from "@executor-js/utils/api-error";
/** Host-owned OAuth configuration and encrypted protocol records. */
import type { UrlPolicy } from "@executor-js/utils/url-policy";
import {
  AuthMethodName,
  type AuthMethodInvalid,
  type ProviderDefinition,
  type ProviderNotFound,
} from "./provider.ts";
import { AccountConnectionId, type CredentialsError, type StorageError } from "./shared.ts";
import { Match, Schema, type Effect, type Redacted } from "effect";
import {
  CredentialHost,
  OAuthAuthorizationParams,
  OAuthClientAuth,
  OAuthSecretClientAuth,
  OAuthTokenRequestFormat,
  OAuthTokenResponse,
  PlacementHeaderName,
} from "apps/contracts";
import { Account, type AccountFieldsInvalid } from "./account.ts";
export { OAuthClientAuth } from "apps/contracts";
import type { HttpClient } from "effect/http";
import { AccountId, HttpUrl, JsonObject, OwnerId, ProviderId } from "./shared.ts";

/**
 * A sign-in URL, its expiry and the callback it sent as `redirect_uri`, which a saved client may
 * have kept from before the host's current one. No account exists until completion succeeds.
 */
export const OAuthSignIn = Schema.Struct({
  authorizationUrl: HttpUrl,
  expiresAt: Schema.Date,
  redirectUri: HttpUrl,
});

export type OAuthSignIn = typeof OAuthSignIn.Type;

export const OAuthClientId = Schema.NonEmptyString.pipe(Schema.brand("OAuthClientId"));
export type OAuthClientId = typeof OAuthClientId.Type;

/** Authorization code needs a redirect; client credentials completes the same connection immediately. */
export const OAuthStartResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("redirect"),
    ...OAuthSignIn.fields,
    /** The stored client this sign-in uses, such as the automatic client it found or created. */
    oauthClient: Schema.optional(OAuthClientId),
  }),
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
]);
export type OAuthStartResult = typeof OAuthStartResult.Type;

/**
 * Where a sign-in's RFC 8707 resource indicator came from, or why it sends none:
 * - `declared`: the provider's own `resource`; `resource: null` declares none.
 * - `metadata`: the protected-resource metadata of the URL the provider discovers from.
 * - `operator`: this instance's own OAuth client for the service, which may set none. A provider's
 *   `resource` does not apply to it.
 * - `inferred_scope_audience`: none, because Executor inferred from the authorization server's own
 *   metadata (a `/v2.0` issuer with `cloud_instance_name`, as Microsoft identity platform publishes)
 *   that it takes the token's audience from the scopes, so it did not send the resource the
 *   protected-resource metadata names. Executor does not verify that inference; a declared
 *   `resource` is always sent.
 * - `none`: none, because the provider declares no `resource` and no metadata names one.
 */
export const OAuthResourceSource = Schema.Literals([
  "declared",
  "metadata",
  "operator",
  "inferred_scope_audience",
  "none",
]);
export type OAuthResourceSource = typeof OAuthResourceSource.Type;
/**
 * The resource indicator a sign-in sends on its authorization request, exchange and renewals, and
 * where it came from. `value` is null when it sends none, and `source` then says why.
 */
export const OAuthResourceIndicator = Schema.Union([
  Schema.Struct({
    value: HttpUrl,
    source: Schema.Literals(["declared", "metadata", "operator"]),
  }),
  Schema.Struct({
    value: Schema.Null,
    source: Schema.Literals(["declared", "operator", "inferred_scope_audience", "none"]),
  }),
]);
export type OAuthResourceIndicator = typeof OAuthResourceIndicator.Type;

const clientSetup = {
  /** `automatic`: a client metadata document or dynamic registration can supply a client. */
  mode: Schema.Literals(["automatic", "client-required"]),
  scopes: Schema.Array(Schema.String),
  /** Signing in uses the instance's own OAuth client, named here; see `FirstPartyOAuthClient`. */
  firstParty: Schema.optionalKey(Schema.Struct({ label: Schema.NonEmptyString })),
  /** The resource indicator sign-in sends, or why it sends none. */
  resource: OAuthResourceIndicator,
};
/** Safe form metadata resolved from provider code and discovery. Never contains client IDs or secrets. */
export const OAuthClientSetup = Schema.Union([
  Schema.Struct({
    ...clientSetup,
    grant: Schema.Literal("authorization_code"),
    /**
     * The authorization server this sign-in uses (see `OAuthClientIssuer`): stored clients
     * registered for it are the ones a connection may name.
     */
    issuer: HttpUrl,
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
/** Inspect the sign-in method for one provider and callback; stored clients are listed separately. */
export const CheckOAuthSetup = Schema.Struct({
  owner: OwnerId,
  provider: ProviderId,
  method: AuthMethodName,
  redirectUri: Schema.optional(HttpUrl),
});

/** No client was named and none can be created automatically for this provider method. */
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
  "scope",
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

/** An RFC 6749 scope token: printable ASCII without spaces, quotes or backslashes. */
const ScopeToken = Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/u));

/**
 * The authorization server an operator's client signs in with, and how its requests are encoded,
 * all as the operator configures them. Every request that carries the client's secret or a user's
 * tokens goes only to these endpoints: provider and app code never choose where. A provider's own
 * declaration only decides whether the client is offered for it.
 */
export const FirstPartyOAuthServer = Schema.Struct({
  /**
   * The server's RFC 8414 issuer, checked against the callback's `iss` and ID tokens. Omitted, it
   * is derived from the token URL and those checks are skipped, as for providers that declare none.
   */
  issuer: Schema.optionalKey(HttpUrl),
  authorizationUrl: HttpUrl,
  tokenUrl: HttpUrl,
  /** RFC 7009 endpoint the client's tokens are revoked at when an account is removed. */
  revocationUrl: Schema.optionalKey(HttpUrl),
  /** Joins requested scopes on the authorization request. Defaults to a space. */
  scopeSeparator: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * Splits the `scope` a token response reports, besides whitespace, such as `,` for GitHub, which
   * reports `repo,gist` whatever separator the request used. Defaults to whitespace only.
   */
  grantedScopeSeparator: Schema.optionalKey(Schema.NonEmptyString),
  /** Extra authorization request parameters, such as `{ access_type: "offline" }`. */
  authorizationParams: Schema.optionalKey(OAuthAuthorizationParams),
  tokenRequestFormat: Schema.optionalKey(OAuthTokenRequestFormat),
  tokenResponse: Schema.optionalKey(OAuthTokenResponse),
  /**
   * The RFC 8707 resource sent on the authorization request, the code exchange and every renewal,
   * such as `https://mcp.slack.com`. A provider's own resource is never sent for this client.
   */
  resource: Schema.optionalKey(HttpUrl),
});
export type FirstPartyOAuthServer = typeof FirstPartyOAuthServer.Type;

/**
 * Where a credential the operator provides is sent: one header, only to the hosts it pins, only
 * over HTTPS. The value is `scheme`, a space and the credential, or the credential alone without a
 * scheme. App and provider code never choose it. Any credential the operator provides is placed
 * this way; its OAuth clients' access tokens are the only kind so far.
 */
export const ManagedPlacement = Schema.Struct({
  /** The only hosts the credential reaches, within the hosts the provider declares. */
  hosts: Schema.Array(CredentialHost).check(Schema.isMinLength(1)),
  /** The header the credential goes in. Defaults to `authorization`. */
  header: Schema.optionalKey(PlacementHeaderName),
  /** Defaults to `Bearer` in `authorization` and to none in any other header. */
  scheme: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
});
export type ManagedPlacement = typeof ManagedPlacement.Type;

/** The operator's name for a credential it provides, such as one of its OAuth clients. */
export const FirstPartyOAuthClientId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
).pipe(Schema.brand("FirstPartyOAuthClientId"));
export type FirstPartyOAuthClientId = typeof FirstPartyOAuthClientId.Type;

/**
 * A host-owned account reporting protocol for one OAuth registration. Endpoints and the subject
 * ID field are reviewed configuration; no app-authored provider can redirect reporting traffic.
 */
export const PersonalDataReporting = Schema.Struct({
  /** Read the identity of one saved subject using that subject's own grant. */
  identityUrl: HttpUrl,
  /** Report stored subject IDs through the registration's 3LO bearer token. */
  reportUrl: HttpUrl,
  /** Top-level field in the identity response containing the provider's stable subject ID. */
  accountIdField: Schema.NonEmptyString,
});
export type PersonalDataReporting = typeof PersonalDataReporting.Type;

/**
 * An OAuth client the instance's operator provides, such as one-click Google sign-in. It is offered
 * for a provider method only when the method's authorization and token endpoints are exactly the
 * client's and the scopes it asks for are among `allowedScopes`; scopes the method only discovered
 * in the resource's advertised list are narrowed to `allowedScopes` instead. Signing in, renewal and
 * revocation then use only the operator's server configuration, and the access token it issues
 * is managed: it reaches app code sealed, goes only as `placement` says, and a token response
 * reporting a scope outside `allowedScopes` is refused. Its secret never leaves the host: grants
 * keep only its ID, so rotating or removing it applies to every account.
 */
export const FirstPartyOAuthClient = Schema.Struct({
  id: FirstPartyOAuthClientId,
  /** Shown when signing in, such as "Executor for Google". */
  label: Schema.NonEmptyString,
  server: FirstPartyOAuthServer,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.optionalKey(Schema.RedactedFromValue(Schema.NonEmptyString)),
  tokenEndpointAuthMethod: OAuthClientAuth,
  /** Requested for a provider method that asks for no scopes. */
  defaultScopes: Schema.Array(ScopeToken),
  /** Every scope a sign-in may ask for and a grant may hold. Defaults to `defaultScopes`. */
  allowedScopes: Schema.optionalKey(Schema.Array(ScopeToken)),
  placement: ManagedPlacement,
  /** Optional host-owned scheduled reporting for personal data held under this registration. */
  personalDataReporting: Schema.optionalKey(PersonalDataReporting),
  /**
   * Withheld from new sign-ins: offered only to reconnect an account whose grant it issued. Its
   * grants keep renewing, so an operator can stop offering a client without stranding them.
   */
  unlisted: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (client) => (client.tokenEndpointAuthMethod === "none") === (client.clientSecret === undefined),
    {
      message: "A client that authenticates at the token endpoint needs its secret, and only then.",
    },
  ),
  Schema.makeFilter(
    (client) =>
      [...client.defaultScopes, ...(client.allowedScopes ?? [])].every(
        (scope) => !scope.includes(client.server.scopeSeparator ?? " "),
      ),
    { message: "A scope cannot contain the server's scope separator." },
  ),
  Schema.makeFilter(
    (client) =>
      client.allowedScopes === undefined ||
      client.defaultScopes.every((scope) => client.allowedScopes?.includes(scope) === true),
    { message: "Every default scope must be allowed." },
  ),
);
export type FirstPartyOAuthClient = typeof FirstPartyOAuthClient.Type;

/** The scopes a client allows: `allowedScopes`, or its defaults when it lists none. */
export const allowedScopes = (client: FirstPartyOAuthClient) =>
  client.allowedScopes ?? client.defaultScopes;

/** Network transport and client identity belong to the product hosting this SDK. */
export interface OAuthOptions {
  readonly httpClient: HttpClient.HttpClient;
  readonly clientName: string;
  /** Host transport policy for callbacks, discovery and every token request. */
  readonly urlPolicy: UrlPolicy;
  readonly clientMetadataUrl?: string;
  /**
   * The callback the host's Client ID Metadata Document lists, which every sign-in as that client
   * sends. Authorization servers may accept only redirect URIs on the document's own origin, so a
   * host whose callback is elsewhere names one there. Unset, those sign-ins send the request's
   * callback, which the document's publisher lists.
   */
  readonly clientMetadataRedirectUri?: string;
  /**
   * Callbacks this host sent as `redirect_uri` before its current one. A saved client someone
   * entered at one of them keeps signing in there, as does one for a server that neither registers
   * clients nor reads a metadata document. Executor registers every other client again at the
   * current callback.
   */
  readonly previousRedirectUris?: readonly string[];
  /**
   * Callbacks this host sent as `redirect_uri` when versions before 4.0.10 saved clients, besides
   * `previousRedirectUris` and `/api/oauth/callback` at its origin. Read only to rebuild the keys
   * of earlier versions: which owner a saved client's key names (`6_stored_oauth_clients`,
   * `9_saved_oauth_clients_by_issuer`) and what a registered client was registered for
   * (`8_oauth_clients_by_issuer`).
   */
  readonly savedClientCallbacks?: readonly string[];
  /**
   * A fixed prefix for every sign-in's OAuth `state`, so a proxy in front of a shared callback
   * URL can tell this host's callbacks apart without a lookup. The random part is unchanged.
   */
  readonly statePrefix?: string;
  /** The operator's own OAuth clients, offered after supplied and saved clients. */
  readonly firstPartyClients?: readonly FirstPartyOAuthClient[];
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
  // The stored client the sign-in started with is no longer one the caller may use.
  "client_unavailable",
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
  // The service refused the RFC 8707 resource indicator, at authorization or the exchange.
  "resource_rejected",
  "destination_blocked",
  "service_unavailable",
  "rate_limited",
  "incompatible_response",
  "unsupported",
  "oauth_unavailable",
  // The operator's client was granted scopes it does not allow.
  "scope_exceeded",
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

/**
 * The service answered RFC 8707's `invalid_target` to a sign-in, which refuses a missing, unknown
 * or unaccepted resource indicator. The recovery goes to whoever can change what the sign-in sends:
 * the app's OAuth settings for a provider's declaration, its discovered metadata or its absence,
 * and the instance administrator for the operator's client, which a provider's `resource` does
 * not change. A refusal whose indicator Executor did not record names no one.
 */
const resourceRejected = (resource: OAuthResourceIndicator | undefined): ErrorPresentation => {
  const declare =
    "Declare the provider's `resource` as the identifier the service documents, or `resource: null` if it takes no resource indicator, then start a fresh sign-in.";
  const declareOne =
    "If the service documents a resource identifier, declare it as the provider's `resource`, then start a fresh sign-in.";
  const administrator = {
    action: "Ask the instance administrator to check the OAuth client’s resource.",
    instructions: (sent: string) =>
      `${sent} This instance's own OAuth client for the service sets it, and a provider's \`resource\` does not apply to that client, so changing the app does not change this request. The instance administrator can compare the client's resource with the identifier the service documents.`,
  };
  const app = "Set the resource the service documents in the app’s OAuth settings.";
  const recovery =
    resource === undefined
      ? {
          recovery: {
            action: "Start a fresh sign-in.",
            instructions:
              "Executor did not record which resource indicator this sign-in sent. Start a fresh sign-in; if the service refuses it too, the new failure names the indicator and who can change it.",
          },
          agentFixable: false,
        }
      : resource.source === "operator"
        ? {
            recovery: {
              action: administrator.action,
              instructions: administrator.instructions(
                resource.value === null
                  ? "Executor sent no RFC 8707 resource indicator."
                  : `Executor sent the RFC 8707 resource indicator ${resource.value}.`,
              ),
            },
            agentFixable: false,
          }
        : {
            recovery: {
              action: app,
              instructions:
                resource.value === null
                  ? Match.value(resource.source).pipe(
                      Match.when(
                        "declared",
                        () =>
                          `Executor sent no RFC 8707 resource indicator, because the provider declares \`resource: null\`. ${declareOne}`,
                      ),
                      Match.when(
                        "inferred_scope_audience",
                        () =>
                          `Executor sent no RFC 8707 resource indicator. The authorization server's metadata has a \`/v2.0\` issuer and a \`cloud_instance_name\`, as Microsoft identity platform's does, so Executor inferred that the server takes the token's audience from the requested scopes and did not send the resource its protected-resource metadata names. Executor did not verify this, and the service refused the sign-in, so it may need a resource. A declared \`resource\` is always sent: declare the identifier the service documents as the provider's \`resource\`, then start a fresh sign-in.`,
                      ),
                      Match.when(
                        "none",
                        () =>
                          `Executor sent no RFC 8707 resource indicator: the provider declares no \`resource\`, and no protected-resource metadata it discovers from names one. ${declareOne}`,
                      ),
                      Match.exhaustive,
                    )
                  : Match.value(resource.source).pipe(
                      Match.when(
                        "metadata",
                        () =>
                          `Executor sent the RFC 8707 resource indicator ${resource.value}, which the service's protected-resource metadata names. The provider declares no \`resource\`, so declaring that same value sends the same request. A service's API and its MCP server can have different identifiers. ${declare}`,
                      ),
                      Match.when(
                        "declared",
                        () =>
                          `Executor sent the RFC 8707 resource indicator ${resource.value}, which the provider declares as its \`resource\`. Compare it with the identifier the service documents, including any path and trailing slash. ${declare}`,
                      ),
                      Match.exhaustive,
                    ),
            },
          };
  return {
    title: "Service refused the requested resource",
    description:
      resource === undefined
        ? "The service reported a missing or unknown resource indicator, so it issued no token."
        : resource.value === null
          ? "The service reported a missing or unknown resource indicator. This sign-in sent none, so it got no token."
          : "The service refused the resource indicator this sign-in sent, so it issued no token.",
    ...recovery,
  };
};

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
    /** With `resource_rejected`, the indicator the sign-in sent, or why it sent none. */
    resource: Schema.optional(OAuthResourceIndicator),
  },
  recorded: ({ reason, cause }) => oauthRecorded("Sign-in completion failed", reason, cause),
  presentation: ({ reason, cause, serviceError, retryAfter, resource }) =>
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
          client_unavailable: {
            title: "OAuth client no longer available",
            description:
              "The OAuth client this sign-in started with was removed, or you may no longer use it, so nothing was saved.",
            recovery: {
              action: "Connect again and choose an OAuth client you can use.",
              instructions:
                "The stored OAuth client the sign-in used was removed, or the product no longer lets this caller use it, before the sign-in finished, so the sign-in could not be completed and no account was saved. Start a fresh sign-in with a client listed in the connection's OAuth setup, or ask an administrator for access.",
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
          resource_rejected: resourceRejected(resource),
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
          // Revocation runs beside the answer and the service may refuse or not support it, so the
          // text does not say it happened.
          scope_exceeded: {
            title: "The service granted more access than allowed",
            description:
              "The service granted this sign-in access beyond what this Executor instance allows for its own OAuth client. Executor rejected the sign-in and saved nothing. When the instance’s client supports revocation, Executor also asks the service to revoke that access.",
            recovery: {
              action: "Ask the instance administrator to check the OAuth client’s scopes.",
              instructions:
                "The token response reported scopes outside the operator client's allowedScopes. Compare the provider's scopes, the operator's allowedScopes and what the service grants. Revocation is best effort: check the oauth.revokeRefused span for its outcome. Do not widen allowedScopes unless the operator intends to allow that access.",
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
  client_unavailable: "restart",
  issuer_mismatch: "configuration",
  denied: "cancelled",
  invalid_scope: "configuration",
  invalid_client: "client",
  authorization_rejected: "configuration",
  authorization_code_rejected: "restart",
  registered_client_rejected: "restart",
  registered_client_incompatible: "configuration",
  exchange_failed: "configuration",
  resource_rejected: "configuration",
  destination_blocked: "configuration",
  service_unavailable: "restart",
  rate_limited: "restart",
  incompatible_response: "configuration",
  unsupported: "configuration",
  oauth_unavailable: "configuration",
  scope_exceeded: "configuration",
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
     * the lost renewal had already replaced it. `scope_exceeded`: renewing a grant to the
     * operator's client reported scopes the client does not allow, so Executor stopped using it
     * and attempted to revoke the renewal's tokens.
     */
    reason: Schema.optional(Schema.Literals(["renewal_interrupted", "scope_exceeded"])),
    cause: Schema.optional(OAuthFailureCause),
    /**
     * The app requirement the account is linked to as an app link, when the app uses it as its own
     * account rather than the caller's: someone who can edit the app must reconnect it.
     */
    appRequirement: Schema.optional(Schema.String),
  },
  recorded: ({ reason, cause, appRequirement }) =>
    oauthRecorded(
      appRequirement === undefined
        ? "An account needs to reconnect"
        : `The app's ${appRequirement} account needs to reconnect`,
      reason,
      cause,
    ),
  presentation: ({ reason, cause, appRequirement }) =>
    withCause(
      {
        title:
          appRequirement === undefined
            ? "An account needs to reconnect"
            : `The app’s “${appRequirement}” account needs to reconnect`,
        description:
          (reason === "renewal_interrupted"
            ? "Executor stopped while renewing this account’s access, before it could save the result. The service no longer accepts the saved sign-in, most likely because that renewal had already replaced it."
            : reason === "scope_exceeded"
              ? "Renewing this account’s access returned more access than this Executor instance allows for its own OAuth client, so Executor stopped using this sign-in. When the instance’s client supports revocation, Executor also asks the service to revoke that access."
              : "The saved sign-in can no longer be used for this account.") +
          (appRequirement === undefined
            ? ""
            : " The app uses this account for everyone, so someone who can edit the app must reconnect it."),
        recovery:
          appRequirement === undefined
            ? {
                action:
                  "Open the app’s Accounts tab and reconnect the affected account, then return to Tools.",
                instructions:
                  "Identify the selected account whose OAuth grant needs renewal. Guide the user through the supported reconnect flow for that same account. Preserve its identity and app links, then verify tool discovery. Do not replace the account or switch authentication methods as a workaround.",
              }
            : {
                action:
                  "Ask someone who can edit this app to reconnect the app’s account from its Accounts tab.",
                instructions:
                  "The account is linked to the app for everyone for this requirement, not linked by the caller. Tell the user someone who can edit the app must reconnect it; a caller cannot replace or reconnect it. Do not link another account as a workaround. Retry once it has been reconnected.",
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
              "Executor could not renew this account’s access. The sign-in endpoint may be unavailable or unreachable. The saved sign-in is kept; this error does not require reconnecting.",
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
            recovery: {
              ...incompatibleResponse.recovery,
              action: "Investigate the incompatible response before retrying renewal.",
            },
          },
          client_rejected: {
            title: "The service rejected Executor’s OAuth client",
            description:
              "The service rejected the OAuth client used for renewal. Check client configuration and how the renewal request authenticates. The account’s sign-in is kept.",
            recovery: {
              action:
                "Check the OAuth client ID and secret at the service. If they changed, reconnect the account and enter the current client details.",
              instructions:
                "The account’s saved OAuth grant is intact; do not delete or replace the account. Compare the client ID, secret and token endpoint authentication method recorded for this provider with the service’s client configuration. If the secret was rotated or the client removed, reconnect this same account with the current client details. If the configuration is correct, investigate the client-authentication request.",
            },
          },
          renewal_rejected: {
            title: "The service refused to renew this account’s access",
            description:
              "The service refused Executor’s request to renew this account’s access without saying the sign-in has ended. The saved sign-in is kept, and Executor tries again the next time the account is used.",
            recovery: {
              action:
                "Inspect the renewal refusal. Retry a temporary failure; reconnect only when the service’s response indicates that it is needed.",
              instructions:
                "The account’s saved OAuth grant is intact. Inspect the recorded provider error code and HTTP status. Retry a temporary refusal. A refusal that continues does not by itself show that the sign-in has ended: reconnect this same account only when the service’s response indicates that reconnecting is needed. Do not replace the account or change its authentication method.",
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
export const OAuthAttemptId = Schema.NonEmptyString.pipe(Schema.brand("OAuthAttemptId"));
export type OAuthAttemptId = typeof OAuthAttemptId.Type;

/** Validated subset of authorization-server metadata used for saved grants. */
export const OAuthTokenServer = Schema.Struct({
  /** Microsoft identity platform's multi-tenant metadata publishes a `{tenantid}` template here. */
  issuer: HttpUrl,
  /**
   * The provider declared endpoints without an issuer. Executor derives `issuer` from the token
   * URL to key automatic clients, but it is not the service's identifier, so callbacks are not checked against it.
   */
  issuer_derived: Schema.optional(Schema.Literal(true)),
  authorization_endpoint: Schema.optional(HttpUrl),
  token_endpoint: HttpUrl,
  registration_endpoint: Schema.optional(HttpUrl),
  /** RFC 7009 endpoint. Optional so grants saved before it was retained still decode. */
  revocation_endpoint: Schema.optional(HttpUrl),
  jwks_uri: Schema.optional(HttpUrl),
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
 * How a stored client came to exist. `manual` clients were entered by a person; `registered`
 * clients were created by dynamic registration. Only a `registered` client is Executor's to
 * discard and replace. A `metadata` client is the host's client metadata document; it is read
 * again on each sign-in and never stored.
 */
export const OAuthClientSource = Schema.Literals(["registered", "metadata", "manual"]);
export type OAuthClientSource = typeof OAuthClientSource.Type;
/**
 * A stored client as one attempt used it. `version` is the stored ciphertext in base64, so a
 * conditional delete removes only the record this attempt saw.
 */
export const OAuthClientUse = Schema.Struct({
  id: OAuthClientId,
  version: Schema.NonEmptyString,
  source: OAuthClientSource,
  /** No sign-in had completed with the client before this attempt. */
  fresh: Schema.Boolean,
});
export type OAuthClientUse = typeof OAuthClientUse.Type;
/** What every sign-in attempt keeps, whichever client it uses. */
const attemptFields = {
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
  response: JsonObject,
};
/** Protocol context frozen when authorization starts, preventing callback-supplied identity changes. */
export const OAuthAttempt = Schema.Struct({
  ...attemptFields,
  server: OAuthServer,
  client: OAuthRegistration,
  /** The stored client this attempt used, so a rejection can discard exactly that version. */
  storedClient: Schema.optionalKey(OAuthClientUse),
  /** An entered client registered under the attempt's owner once it completes. */
  saveClient: Schema.optionalKey(Schema.Literal(true)),
  resource: Schema.optional(HttpUrl),
  /** Where `resource` came from, so a refusal can say. Attempts started before it was kept lack it. */
  resourceSource: Schema.optional(OAuthResourceSource),
  /** Token request encoding and nested grant location, as the provider declared them. */
  tokenRequestFormat: Schema.optional(OAuthTokenRequestFormat),
  tokenResponse: Schema.optional(OAuthTokenResponse),
});
/**
 * An attempt that signs in with the operator's client named by `firstParty`. It keeps no server or
 * client: the exchange reads both from the operator's current configuration, and fails if the
 * client is gone. Without them, a server that knows no operator clients cannot decode the attempt,
 * so it can never complete one as a credential the user brought.
 */
export const OAuthFirstPartyAttempt = Schema.Struct({
  ...attemptFields,
  firstParty: FirstPartyOAuthClientId,
});
export type OAuthFirstPartyAttempt = typeof OAuthFirstPartyAttempt.Type;
/** A stored sign-in attempt. */
export const OAuthAttemptRecord = Schema.Union([OAuthAttempt, OAuthFirstPartyAttempt]);
/** Whether an attempt signs in with the operator's client. */
export const isFirstPartyAttempt = (
  attempt: typeof OAuthAttemptRecord.Type,
): attempt is OAuthFirstPartyAttempt => "firstParty" in attempt;
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
/**
 * The account's credential generation the grant belongs to. The grant is read with its fields, so
 * an invocation that reads them uses this generation even if a reconnect replaced the account's
 * credential since it was selected. Grants saved before it was retained belong to the account's
 * current generation, since every sign-in since then records it.
 */
const grantGeneration = Schema.optional(Schema.Int);
/** Private renewal context; machine grants retain scopes and exchange client credentials again. */
export const OAuthGrant = Schema.Union([
  Schema.Struct({
    ...grantFields,
    grant: Schema.optionalKey(Schema.Literal("authorization_code")),
    server: OAuthServer,
    client: OAuthRegistration,
    /** The stored client signed in with. The grant keeps its own copy for renewal. */
    oauthClient: Schema.optionalKey(OAuthClientId),
    refreshToken: Schema.optional(Schema.NonEmptyString),
    /**
     * Scopes each refresh asks for again, space-separated. Only imported grants carry them, as the
     * product that issued the grant sent them; other refreshes ask for none, keeping what was
     * granted (RFC 6749 §6).
     */
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Nested grant location frozen at sign-in; renewals read the same member. */
    tokenResponse: Schema.optional(OAuthTokenResponse),
    generation: grantGeneration,
  }),
  Schema.Struct({
    ...grantFields,
    grant: Schema.Literal("client_credentials"),
    server: OAuthTokenServer,
    client: OAuthConfidentialRegistration,
    scopes: Schema.Array(Schema.String),
    /** Joins `scopes` on each exchange. Grants saved before it was retained use a space. */
    scopeSeparator: Schema.optional(Schema.NonEmptyString),
    generation: grantGeneration,
  }),
  /**
   * A grant issued to the operator's client named by `firstParty`; its access token is managed. It
   * keeps no server or client; renewal and revocation read both from the operator's current
   * configuration. Without them, a server that knows no operator clients cannot decode the grant,
   * so it can never release these tokens as a credential the user brought.
   */
  Schema.Struct({
    grant: Schema.Literal("authorization_code"),
    firstParty: FirstPartyOAuthClientId,
    response: JsonObject,
    expiresAt: Schema.optional(Schema.Number),
    fields: JsonObject,
    refreshToken: Schema.optional(Schema.NonEmptyString),
    /**
     * Scopes each refresh asks for again. Only imported grants carry them, as the product that
     * issued the grant sent them; see the other authorization code grant's `scopes`.
     */
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    generation: Schema.Int,
  }),
]);
export type OAuthGrant = typeof OAuthGrant.Type;
/** A grant issued to the operator's client. */
export type OAuthFirstPartyGrant = Extract<
  OAuthGrant,
  { readonly firstParty: FirstPartyOAuthClientId }
>;
/** Whether a grant was issued to the operator's client. */
export const isFirstPartyGrant = (grant: OAuthGrant): grant is OAuthFirstPartyGrant =>
  "firstParty" in grant;

/**
 * An account whose OAuth grant was issued by another product, as the Executor v1 importer saves
 * it (`notes/v1-import.md`). Internal to that importer and deleted with it; not part of the HTTP
 * or Promise API. The grant was issued either to a client the product registered, which the
 * account keeps (`client`), or to one of the operator's own clients (`firstParty`), which must
 * be the same client at the authorization server: the same client ID, so its refresh token is
 * valid for it.
 */
export type ImportOAuthGrant = {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly method: string;
  readonly label: string;
  /** The callback the client was registered with, for an authorization-code grant. */
  readonly redirectUri?: string | undefined;
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken?: Redacted.Redacted<string> | undefined;
  /** Epoch milliseconds when the access token expires. */
  readonly expiresAt?: number | undefined;
} & (
  | {
      /** The client the grant was issued to, with its secret. */
      readonly client: Redacted.Redacted<OAuthRegistration>;
      /**
       * How renewals ask for a token, as the product that issued the grant did. It replaces what
       * the provider's method declares: the token endpoint, the scopes asked for again (none when
       * empty) and the RFC 8707 resource (none when absent).
       */
      readonly renewal: {
        readonly tokenEndpoint: string;
        readonly scopes: readonly string[];
        readonly resource?: string | undefined;
      };
    }
  | {
      /**
       * The operator's client the grant was issued to. The account's token is managed, and the
       * grant renews and is revoked with the operator's current configuration, as one a sign-in
       * with that client saves.
       */
      readonly firstParty: FirstPartyOAuthClientId;
      /**
       * The hosts the app the account is imported for declares for the provider, which a
       * connection would grant it; the client's tokens must reach every one of them, or the
       * app's calls to the others would be refused.
       */
      readonly hosts: readonly string[];
      /** The scopes renewals ask for again (none when empty); each must be one the client allows. */
      readonly renewal: { readonly scopes: readonly string[] };
    }
);
/**
 * Why a grant to one of the operator's clients cannot be imported: the operator does not offer
 * that client (`unavailable`), the provider's method would not sign in with it (`method`), the
 * grant holds a scope the client does not allow (`scopes`), or the client's tokens do not reach
 * every host the account's app declares (`hosts`, with the `unreachable` ones). Internal to the v1
 * importer.
 */
export class OAuthGrantNotImportable extends Schema.TaggedError<OAuthGrantNotImportable>()(
  "OAuthGrantNotImportable",
  {
    reason: Schema.Literals(["unavailable", "method", "scopes", "hosts"]),
    unreachable: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}
/**
 * One of the operator's clients as the importer checks a grant against it, without its secret. Its
 * client ID is public; the importer compares it with the one v1's grants were issued to.
 */
export type FirstPartyOAuthClientDescription = Omit<FirstPartyOAuthClient, "clientSecret">;
/** Host-only access to {@link ImportOAuthGrant}. */
export const OAuthGrantImport = Symbol("executor.OAuthGrantImport");
export interface OAuthGrantImport {
  /**
   * Save the account, its encrypted grant (ready to use and renew) and its client in one
   * transaction, as completing a sign-in does. The provider's method must be OAuth with the same
   * grant. Runs the provider's discovery, but no token request.
   */
  readonly importOAuthGrant: (
    input: ImportOAuthGrant,
  ) => Effect.Effect<
    typeof Account.Type,
    | StorageError
    | CredentialsError
    | ProviderNotFound
    | AuthMethodInvalid
    | OAuthSetupFailed
    | OAuthGrantNotImportable
  >;
  /**
   * Check the grant as `importOAuthGrant` would, against `definition`, the provider an app that is
   * not deployed declares, and save nothing: the v1 import's dry run refuses exactly the grants an
   * import would. Runs the provider's discovery, but no token request.
   */
  readonly checkOAuthGrant: (
    input: ImportOAuthGrant & { readonly definition: ProviderDefinition },
  ) => Effect.Effect<void, AuthMethodInvalid | OAuthSetupFailed | OAuthGrantNotImportable>;
  /**
   * Check an account's fields as `managedAccounts.add` would, against `definition`, the provider an
   * app that is not deployed declares, and save nothing.
   */
  readonly checkAccountFields: (input: {
    readonly provider: ProviderId;
    readonly definition: ProviderDefinition;
    readonly method: string;
    readonly fields: Redacted.Redacted<JsonObject>;
  }) => Effect.Effect<void, AuthMethodInvalid | AccountFieldsInvalid>;
  /** The operator's client `id` when it is offered here, which its credentials being set decides. */
  readonly firstPartyClient: (id: string) => FirstPartyOAuthClientDescription | undefined;
  /**
   * Whether an imported account's stored credentials, and its OAuth grant when its method signs in
   * with one, decrypt with this deployment's key. Reads only and returns no value; an import
   * verifies its accounts with it.
   */
  readonly credentialsReadable: (account: AccountId) => Effect.Effect<boolean, StorageError>;
  /**
   * Move an imported account to another provider, under `method`, when that method's definition is
   * the one the account was saved for, so its credentials fit unchanged. An importer that
   * generates an app again uses it for the accounts an earlier run saved: the app's provider
   * changes with any method it gains or loses, or a new name. Returns whether it moved.
   */
  readonly moveImportedAccount: (input: {
    readonly account: AccountId;
    readonly provider: ProviderId;
    readonly method: string;
  }) => Effect.Effect<boolean, StorageError>;
  /**
   * Replace an imported account's tokens with those the issuing product holds now, when the
   * product holds another refresh token and the grant needs reconnecting or the product renewed
   * the grant after this account did: a service that rotates refresh tokens keeps only the last
   * renewal's. Keeps the grant's client and renewal settings, and keeps a grant reconnected since
   * the import. A grant being renewed is decided once its renewal saved the result. Makes no token
   * request.
   */
  readonly refreshImportedGrant: (
    account: AccountId,
    tokens: ImportedGrantTokens,
  ) => Effect.Effect<"kept" | "replaced", StorageError | CredentialsError>;
  /**
   * Remove an account an import saved, as `accounts.remove` does, without revoking its grant at
   * the provider: the issuing product holds the same grant and keeps using it once the import is
   * rolled back.
   */
  readonly removeImportedAccount: import("./executor.ts").Executor["accounts"]["remove"];
}
/** An imported grant's tokens as the issuing product holds them (`refreshImportedGrant`). */
export type ImportedGrantTokens = Pick<
  ImportOAuthGrant,
  "accessToken" | "refreshToken" | "expiresAt"
>;
