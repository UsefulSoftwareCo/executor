import type { AppAccountUse, ResourceLifecycle } from "../contracts/executor.ts";
import type { BackgroundWork } from "../contracts/declarations.ts";
/** Trusted OAuth lifecycle. Provider definitions never contain client secrets or saved grants. */
import { parseDestination, parseEndpoint, httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import {
  Array as Arr,
  Clock,
  Context,
  type Crypto,
  Effect,
  Exit,
  Fiber,
  JsonSchema,
  Match,
  Redacted,
  Schema,
  SchemaRepresentation,
  Struct,
} from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  AccountConnectionRefused,
  AccountConnectionTargetChanged,
  StartConnectionOAuth,
  CompleteConnectionOAuth,
  FindConnectionOAuth,
} from "../contracts/account-connection.ts";
import {
  openConnection,
  readConnection,
  requireOpen,
  finishConnection,
  lockConnection,
  recordSignInFailure,
  startSignIn,
} from "./connection-state.ts";
import { requireTargetProvider } from "./connection-target.ts";
import { Account } from "../contracts/account.ts";
import {
  OAuthClientUnavailable,
  type CheckOAuthSetup,
  type OAuthClientSetup,
  OAuthCompletionFailed,
  type OAuthCompletionReason,
  OAuthAttempt,
  OAuthAttemptId,
  OAuthAttemptRecord,
  OAuthFirstPartyAttempt,
  OAuthServer,
  allowedScopes,
  type FirstPartyOAuthClient,
  type FirstPartyOAuthClientId,
  isFirstPartyAttempt,
  isFirstPartyGrant,
  OAuthClientId,
  OAuthGrant,
  OAuthReconnectRequired,
  OAuthRegistration,
  OAuthRenewalFailed,
  OAuthConfidentialRegistration,
  OAuthSetupFailed,
  OAuthClientAuth,
  OAuthClientSource,
  type OAuthClientUse,
  type OAuthFailureCause,
  type OAuthOptions,
  type OAuthTokenServer,
  type ImportOAuthGrant,
  OAuthGrantNotImportable,
} from "../contracts/oauth.ts";
import {
  OAuthAutomaticClient,
  OAuthClient,
  OAuthClientInputs,
  OAuthClientExists,
  OAuthClientNotEditable,
  OAuthClientNotFound,
  OAuthClientReference,
  OAuthClientsUnsupported,
} from "../contracts/oauth-clients.ts";
import {
  AuthMethodInvalid,
  Provider,
  ProviderNotFound,
  type ProviderDefinition,
} from "../contracts/provider.ts";
import {
  AccountId,
  HttpUrl,
  JsonObject,
  StorageError,
  type AppId,
  type OwnerId,
  type ProviderId,
} from "../contracts/shared.ts";
import { StoredAccount, type Credentials } from "../contracts/storage.ts";
import { type AccountCredential, invocationAccount } from "./provider.ts";
import { intersectCredentialHosts } from "./credential-handles.ts";
import { query, transaction, type Query } from "./database.ts";
import {
  claimCredentials,
  credentialsDigest,
  credentialsOwner,
  legacyCredentialsDigest,
  oauthClientIssuer,
  registeredClientKey,
  withdrawCredentials,
} from "./stored-oauth-client-credentials.ts";
import {
  clientRegistration,
  isOAuthErrorResponse,
  makeOAuthProtocol,
  preferredClientMethod,
  registrationGrantTypes,
  type OAuthProtocolFailed,
} from "./oauth-protocol.ts";
import { defaultLabel, ownedAccount } from "./accounts.ts";
import type { OAuthCallbackField, OAuthFailureDetail } from "./oauth-diagnostics.ts";

/**
 * A stored client's encrypted part: its ID and secret, and for a registered client the rest of
 * the registration the service issued. A client entered by a person has no recorded method.
 */
export const StoredClientSecret = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.NonEmptyString),
  token_endpoint_auth_method: Schema.optional(OAuthClientAuth),
  client_secret_expires_at: Schema.optional(Schema.Number),
});
export type StoredClientSecret = typeof StoredClientSecret.Type;

/** A row of `storedOAuthClients`, as the client store writes it. */
interface StoredClientRow {
  readonly id: OAuthClientId;
  readonly owner: OwnerId;
  /** Only on a client stored before 4.0.12 whose issuer has not been recorded. */
  readonly provider: ProviderId | null;
  readonly issuer: string | null;
  readonly clientId: string;
  readonly source: OAuthClientSource;
  readonly hasSecret: boolean;
  readonly automaticKey: string | null;
  readonly confirmed: boolean;
  readonly encrypted: Uint8Array;
  readonly createdAt: Date;
}

/**
 * Whose stored clients a sign-in may use: the owner's for the server it signs in at. The provider
 * finds the clients and credentials stored before 4.0.12, which name it rather than a server.
 */
interface ClientScope {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly issuer: string;
}

/** The connection a stored client is used for. */
interface SignInScope {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly method: string;
}

/** A client of the owner for this server, or stored before 4.0.12 for this provider. */
const inScope = (row: Pick<StoredClientRow, "owner" | "issuer" | "provider">, scope: ClientScope) =>
  row.owner === scope.owner &&
  (row.issuer === null ? row.provider === scope.provider : row.issuer === scope.issuer);

/** Credentials a client of another server holds: this sign-in may never use them. */
const unusableHere = (
  found:
    | { readonly kind: "held"; readonly row: StoredClientRow }
    | {
        readonly kind: "withdrawn";
        readonly client: OAuthClientId;
        readonly withdrawal: string | null;
      },
) =>
  ({
    kind: "withdrawn",
    client: found.kind === "held" ? found.row.id : found.client,
    withdrawal: null,
  }) as const;

const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));

/**
 * A stored client's registration as a sign-in reads it: the one the service issued, or none for a
 * client entered by a person, which authenticates as each sign-in's discovery says. An owner move
 * reads stored clients with this too, so it refuses exactly the ones a sign-in could not use.
 */
export const storedRegistration = (secret: StoredClientSecret) =>
  secret.token_endpoint_auth_method === undefined
    ? Effect.succeed(undefined)
    : decode(OAuthRegistration, secret);

/** Apply the authored output schema after removing host-only token material. */
const project = (response: JsonObject, fields: unknown) =>
  Effect.gen(function* () {
    const input = yield* decode(JsonObject, fields);
    const publicFields = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          !["refresh_token", "id_token", "client_secret", "client_assertion"].includes(key),
      ),
    );
    const decoder = yield* Effect.try({
      try: () =>
        Schema.toType(
          SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(response)),
        ),
      catch: () => new StorageError(),
    });
    return yield* Schema.decodeUnknownEffect(decoder)(publicFields).pipe(
      Effect.flatMap((fields) => decode(JsonObject, fields)),
      Effect.mapError(() => new StorageError()),
    );
  });

/** Safe evidence from a protocol failure, kept on the user-facing error for diagnosis. */
const causeOf = (
  stage: OAuthFailureCause["stage"],
  error: OAuthProtocolFailed,
): OAuthFailureCause => ({
  stage,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.providerError === undefined ? {} : { providerError: error.providerError }),
  ...(error.field === undefined ? {} : { field: error.field }),
});

/** The service's own error, for the person connecting; renewal failures do not carry it. */
const serviceErrorOf = (error: OAuthProtocolFailed) =>
  error.serviceError === undefined ? {} : { serviceError: error.serviceError };

/** The time a rate-limited service named in Retry-After. Only `rate_limited` failures carry it. */
const retryAfterOf = (reason: string, error: OAuthProtocolFailed) =>
  reason === "rate_limited" && error.retryAfter !== undefined
    ? { retryAfter: error.retryAfter }
    : {};

/**
 * RFC 6749 §5.1 gives a token's lifetime in seconds from issue. oauth4webapi rejects negative
 * values. A lifetime of zero states no usable lifetime, so it is treated like an omitted one
 * rather than as a token that is already expired, which would renew on every use or, without
 * a refresh token, require reconnection immediately.
 */
const expiry = (issuedAt: number, expiresIn: number | undefined) =>
  expiresIn === undefined || expiresIn <= 0 ? {} : { expiresAt: issuedAt + expiresIn * 1000 };

/**
 * A renewal claim is a lease its holder keeps alive. While the holder renews, it confirms the
 * claim every `renewalHeartbeat`; other resolves wait for it, however long its token request
 * takes. A claim unconfirmed for `renewalLease` belongs to a process that stopped without
 * settling it, for example from an out-of-memory kill. The next resolve then takes it over and
 * renews from the saved grant. The lease spans several heartbeats so a busy process or a slow
 * database write does not lose a live claim, and is short enough that callers arriving after a
 * restart recover within one execute deadline.
 */
const sameFields = Schema.toEquivalence(JsonObject);

const renewalHeartbeat = 5_000;
const renewalLease = 20_000;

/**
 * Claims held by renewals running in this process. A claim listed here is live whatever its
 * last confirmation, so a stall that delays heartbeats, such as garbage collection near the
 * memory limit, cannot make this process take over its own renewal.
 */
const heldClaims = new Set<string>();

/** A stored grant row, as the resolve loop reads it. */
export interface GrantRow {
  readonly id: string;
  readonly encrypted: Uint8Array;
  readonly status: string;
  readonly updatedAt: Date;
}
/**
 * SDK-internal: grant rows a tool call read in one batch with its checks, by account. An account's
 * first read in the resolve loop takes its row instead of reading again; a row is used once, and
 * all are dropped as soon as any account waits for a renewal, since they are older than that wait.
 */
export const GrantReadAhead = Context.Reference<Map<AccountId, GrantRow | null> | undefined>(
  "executor/GrantReadAhead",
  { defaultValue: () => undefined },
);

/** Why a saved grant cannot supply credentials. Recorded on the resolve and usable spans. */
type ReconnectReason =
  | "grant_missing"
  | "grant_unusable"
  | "renewal_interrupted"
  | "not_renewable"
  | "renewal_refused"
  | "scope_exceeded";

/** Span attributes for a safe failure cause, matching the protocol spans' attribute names. */
const causeAttributes = (cause: OAuthFailureCause) => ({
  "oauth.error.stage": cause.stage,
  ...(cause.status === undefined ? {} : { "http.response.status_code": cause.status }),
  ...(cause.providerError === undefined
    ? {}
    : { "oauth.error.provider_code": cause.providerError }),
  ...(cause.field === undefined ? {} : { "oauth.error.field": cause.field }),
});

/**
 * The product no longer authorizes a use of a selected account, before its credentials resolve or
 * after a renewal. Unlike a storage failure it lasts until access changes, so retrying does not
 * help: removal that the product refuses waits for a person instead. Callers that do not tell the
 * two apart see it as `StorageError`.
 */
export class AccountUseRefused extends Schema.TaggedError<AccountUseRefused>()(
  "AccountUseRefused",
  {},
) {}

/**
 * Whether resolving credentials waited for, or performed, a renewal. Only then can it outlive a
 * permission change, so only then is product authority checked again afterwards.
 */
interface Resolution {
  contested: boolean;
}
/**
 * What credentials are resolved for: running the app's code, removing what the app registered,
 * or checking an account outside the app's code.
 */
type CredentialUse =
  | { readonly kind: "run"; readonly app: { readonly id: AppId; readonly owner: OwnerId } }
  | { readonly kind: "removal"; readonly app: { readonly id: AppId; readonly owner: OwnerId } }
  | { readonly kind: "check" };
/**
 * How an evaluation uses one account: whether a user requirement uses it (`user`), and the app
 * requirements it fills (`appUses`). Each use is authorized on its own; see `ResourceLifecycle`.
 */
export interface AccountUses {
  readonly user: boolean;
  readonly appUses: readonly string[];
}

/** Spans that can find a grant that needs reconnecting. */
type ReconnectSpan = "oauth.resolve" | "oauth.usable";

/**
 * A grant that needs reconnecting is an expected account state, not a fault of the operation that
 * found it. Record why as the span's outcome and return the failure as a value; the operation fails
 * its caller with it only after the span has ended, so the span carries no error status.
 */
const reconnectRequired = (
  span: ReconnectSpan,
  account: AccountId,
  reason: ReconnectReason,
  cause?: OAuthFailureCause,
) =>
  Effect.annotateCurrentSpan({
    [`${span}.outcome`]: "reconnect",
    "oauth.reconnect.reason": reason,
    ...(cause === undefined ? {} : causeAttributes(cause)),
  }).pipe(
    Effect.as(
      new OAuthReconnectRequired({
        account,
        ...(reason === "renewal_interrupted" || reason === "scope_exceeded" ? { reason } : {}),
        ...(cause === undefined ? {} : { cause }),
      }),
    ),
  );

/**
 * Classify a failed request by who must act. A 429 is the service limiting requests: Executor
 * reached it, so it is not an outage. A 2xx response that failed validation is an Executor
 * compatibility problem; a 3xx or 4xx, or an RFC 6749 error body with any status, is the service
 * refusing the request.
 */
const outcome = (error: OAuthProtocolFailed) =>
  error.reason === "destination_blocked"
    ? "blocked"
    : error.status === undefined
      ? error.reason === "request"
        ? "unavailable"
        : "unanswered"
      : error.status === 429
        ? "limited"
        : error.status >= 500 ||
            error.providerError === "server_error" ||
            error.providerError === "temporarily_unavailable"
          ? "unavailable"
          : error.status >= 300 || error.code === "OAUTH_RESPONSE_BODY_ERROR"
            ? "rejected"
            : "incompatible";

/**
 * Classify a failed renewal. Only RFC 6749 §5.2's `invalid_grant` says this account's grant has
 * ended: its refresh token was revoked, expired or already used. Every other refusal keeps the
 * grant, because it says nothing about it:
 *
 * - `invalid_client`, `unauthorized_client` and a 401 are about the OAuth client, which every
 *   account on that client shares. They are also what a fault in Executor's own client
 *   authentication produces; ending every grant for that would force every user to sign in again
 *   once it is fixed. The account reports `client_rejected` and renews again on its next use.
 * - Other codes, including ones outside RFC 6749 that some services return with HTTP 200, such as
 *   Slack's `internal_error`, report `renewal_rejected` and renew again on the next use.
 * - An outage, timeout, 5xx, `server_error` or `temporarily_unavailable` is temporary, and so is a
 *   429, which reports `rate_limited`.
 * - A response Executor cannot use, including a malformed 2xx or a 4xx without an error body, is
 *   a compatibility problem.
 *
 * One other failure ends the grant: a token endpoint the host policy now refuses cannot renew
 * this saved grant. A new sign-in settles it.
 */
const renewalOutcome = (error: OAuthProtocolFailed): "reconnect" | OAuthRenewalFailed["reason"] =>
  Match.value(outcome(error)).pipe(
    Match.when("blocked", () => "reconnect" as const),
    Match.when("unavailable", () => "service_unavailable" as const),
    Match.when("limited", () => "rate_limited" as const),
    Match.when("rejected", () =>
      error.reason === "invalid_grant"
        ? ("reconnect" as const)
        : error.reason === "invalid_client" ||
            error.providerError === "unauthorized_client" ||
            error.status === 401
          ? ("client_rejected" as const)
          : isOAuthErrorResponse(error)
            ? ("renewal_rejected" as const)
            : ("incompatible_response" as const),
    ),
    Match.whenOr("incompatible", "unanswered", () => "incompatible_response" as const),
    Match.exhaustive,
  );

const registrationFailed = (error: OAuthProtocolFailed, callbackUrl: typeof HttpUrl.Type) => {
  const reason = Match.value(outcome(error)).pipe(
    Match.when("blocked", () => "discovery_blocked" as const),
    Match.when("unavailable", () => "service_unavailable" as const),
    Match.when("limited", () => "rate_limited" as const),
    Match.when("rejected", () =>
      error.providerError === "invalid_redirect_uri"
        ? ("client_not_approved" as const)
        : error.providerError === "invalid_client_metadata"
          ? ("client_metadata_rejected" as const)
          : // RFC 7591 section 3: the endpoint requires an initial access token, which Executor
            // never holds. The service only accepts clients registered by hand.
            error.status === 401 || error.status === 403
            ? ("client_registration_required" as const)
            : ("registration_rejected" as const),
    ),
    // Checks after a successful response, such as a changed auth method, carry no status.
    Match.whenOr("incompatible", "unanswered", () => "incompatible_response" as const),
    Match.exhaustive,
  );
  return new OAuthSetupFailed({
    cause: causeOf("register", error),
    ...serviceErrorOf(error),
    ...retryAfterOf(reason, error),
    callbackUrl,
    reason,
  });
};

const clientCredentialsFailed = (error: OAuthProtocolFailed) => {
  const reason =
    error.reason === "invalid_client" || error.reason === "unsupported"
      ? error.reason
      : Match.value(outcome(error)).pipe(
          Match.when("unavailable", () => "service_unavailable" as const),
          Match.when("limited", () => "rate_limited" as const),
          Match.when("incompatible", () => "incompatible_response" as const),
          Match.whenOr("blocked", "rejected", "unanswered", () => "token_exchange" as const),
          Match.exhaustive,
        );
  return new OAuthSetupFailed({
    cause: causeOf("clientCredentials", error),
    ...serviceErrorOf(error),
    ...retryAfterOf(reason, error),
    reason,
  });
};

/** A failed token exchange. Callback validation runs first, so every failure here reached the token endpoint or failed before sending. */
const exchangeFailed = (error: OAuthProtocolFailed) => {
  const reason =
    error.reason === "invalid_client" || error.reason === "unsupported"
      ? error.reason
      : error.reason === "invalid_grant"
        ? "authorization_code_rejected"
        : Match.value(outcome(error)).pipe(
            Match.when("blocked", () => "destination_blocked" as const),
            Match.when("unavailable", () => "service_unavailable" as const),
            Match.when("limited", () => "rate_limited" as const),
            Match.when("rejected", () => "exchange_failed" as const),
            // A 2xx that failed validation, or a request the library refused to build.
            Match.whenOr("incompatible", "unanswered", () => "incompatible_response" as const),
            Match.exhaustive,
          );
  return new OAuthCompletionFailed({
    cause: causeOf("exchange", error),
    ...serviceErrorOf(error),
    ...retryAfterOf(reason, error),
    reason,
  });
};

/**
 * Slack's `user_scope` authorization parameter lists, comma-separated, the permissions for the
 * signed-in user's own token. A declared parameter replaces the endpoint's own, as authorization does.
 */
const userScopes = (endpoint: string, params: Readonly<Record<string, string>> | undefined) => [
  ...new Set(
    (params?.["user_scope"] ?? new URL(endpoint).searchParams.get("user_scope") ?? "")
      .split(/[\s,]+/u)
      .filter((scope) => scope !== ""),
  ),
];

/**
 * A client entered with a secret uses Basic, which RFC 6749 section 2.3.1 requires servers to
 * support, unless the server advertises only the body form. A server accepting both says nothing
 * about how this client was registered (RFC 7591 section 2). Declared endpoints advertise
 * nothing, so services that read only the body, such as HubSpot, declare `client_secret_post`.
 */
const secretMethod = (supported: readonly string[] | undefined) =>
  supported === undefined ||
  supported.includes("client_secret_basic") ||
  !supported.includes("client_secret_post")
    ? ("client_secret_basic" as const)
    : ("client_secret_post" as const);

/**
 * A failed authorization response: its RFC 9207 issuer, then an RFC 6749 §4.1.2.1 error code.
 * Codes outside the recorded vocabulary are still authorization errors, never a cancellation.
 */
const callbackFailed = (error: OAuthProtocolFailed) =>
  new OAuthCompletionFailed({
    cause: causeOf("authorize", error),
    ...serviceErrorOf(error),
    reason:
      error.field === "issuer"
        ? "issuer_mismatch"
        : error.code !== "OAUTH_AUTHORIZATION_RESPONSE_ERROR"
          ? "callback_malformed"
          : Match.value(error.providerError).pipe(
              Match.when("access_denied", () => "denied" as const),
              Match.whenOr(
                "invalid_client",
                "unauthorized_client",
                () => "invalid_client" as const,
              ),
              Match.when("invalid_scope", () => "invalid_scope" as const),
              Match.whenOr(
                "server_error",
                "temporarily_unavailable",
                () => "service_unavailable" as const,
              ),
              Match.orElse(() => "authorization_rejected" as const),
            ),
  });

/** Compose persisted sign-in and refresh operations with the host's encryption and transport. */
export const makeOAuth = (
  db: Query,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  options?: OAuthOptions,
  lifecycle?: ResourceLifecycle,
  background?: BackgroundWork,
) => {
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new StorageError()),
    );
  const nextId = crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
  const protocol = options === undefined ? undefined : makeOAuthProtocol(options);
  const firstPartyClients = new Map(
    (options?.firstPartyClients ?? []).map((client) => [client.id, client] as const),
  );
  /**
   * The scopes a token response for the operator's client reports granting, or undefined when it
   * reports none, which grants what was requested (RFC 6749 §5.1) or, on renewal, what the grant
   * held (§6). Scopes are whitespace-delimited, and also split on the server's
   * `grantedScopeSeparator`, such as GitHub's `repo,gist`; never on the request's `scopeSeparator`.
   */
  const grantedScopes = (client: FirstPartyOAuthClient, scope: string | undefined) => {
    if (scope === undefined) return undefined;
    const separator = client.server.grantedScopeSeparator;
    return scope
      .split(/\s+/u)
      .flatMap((part) => (separator === undefined ? [part] : part.split(separator)))
      .filter((granted) => granted !== "");
  };
  /** Whether a token response for the operator's client reports only scopes the client allows. */
  const grantAllowed = (id: FirstPartyOAuthClientId, scope: string | undefined) => {
    const client = firstPartyClients.get(id);
    if (client === undefined) return false;
    const allowed = allowedScopes(client);
    return (grantedScopes(client, scope) ?? []).every((granted) => allowed.includes(granted));
  };
  /**
   * The operator's client and authorization server as configured now, or undefined when the
   * operator removed it. Attempts and grants keep only its ID, so every request that carries its
   * secret or a user's tokens goes where the operator says now, and a rotated secret applies to
   * every account.
   */
  const operatorClient = (id: FirstPartyOAuthClientId) =>
    Effect.gen(function* () {
      const client = firstPartyClients.get(id);
      if (client === undefined) return undefined;
      const { server } = client;
      const registration: OAuthRegistration =
        client.tokenEndpointAuthMethod === "none" || client.clientSecret === undefined
          ? { client_id: client.clientId, token_endpoint_auth_method: "none" }
          : {
              client_id: client.clientId,
              token_endpoint_auth_method: client.tokenEndpointAuthMethod,
              client_secret: Redacted.value(client.clientSecret),
            };
      return {
        client: registration,
        server: yield* decode(OAuthServer, {
          ...(server.issuer === undefined
            ? { issuer: new URL(server.tokenUrl).origin, issuer_derived: true }
            : { issuer: server.issuer }),
          authorization_endpoint: server.authorizationUrl,
          token_endpoint: server.tokenUrl,
          ...(server.revocationUrl === undefined
            ? {}
            : { revocation_endpoint: server.revocationUrl }),
        }),
        ...(server.tokenRequestFormat === undefined
          ? {}
          : { tokenRequestFormat: server.tokenRequestFormat }),
        ...(server.tokenResponse === undefined ? {} : { tokenResponse: server.tokenResponse }),
        // Sent on the exchange and every renewal, as on the authorization request.
        ...(server.resource === undefined ? {} : { resource: server.resource }),
      };
    });
  /**
   * A grant as renewal and revocation use it: a grant to the operator's client gets the client's
   * current configuration, and is undefined when the operator removed the client.
   */
  const operatingGrant = (grant: OAuthGrant) =>
    Effect.gen(function* () {
      if (!isFirstPartyGrant(grant)) return grant;
      const operator = yield* operatorClient(grant.firstParty);
      if (operator === undefined) return undefined;
      const { firstParty: _firstParty, generation: _generation, ...rest } = grant;
      return { ...rest, ...operator };
    });

  /**
   * Renew an authorization code grant with its refresh token. Undefined when it has none, or when
   * the operator removed the client that issued it.
   */
  const refreshOf = (
    protocol: ReturnType<typeof makeOAuthProtocol>,
    grant: Exclude<OAuthGrant, { readonly grant: "client_credentials" }>,
  ) =>
    Effect.gen(function* () {
      const operating = yield* operatingGrant(grant);
      return grant.refreshToken === undefined ||
        operating === undefined ||
        operating.grant === "client_credentials"
        ? undefined
        : protocol.refresh({ ...operating, refreshToken: grant.refreshToken });
    });

  /**
   * The operator's client to sign in with, and the scopes to ask for, when one is configured for
   * exactly the method's authorization and token endpoints. The endpoints decide only whether it
   * is offered: an issuer, which a provider can claim, never does, and signing in uses the
   * operator's endpoints whatever the provider declares. The method's scopes are asked for, or the
   * client's `defaultScopes` when it declares none, and every one must be among `allowedScopes`.
   * Scopes discovered only in the resource's advertised list are what it offers, not what it
   * requires, so they are narrowed to `allowedScopes`; the client is offered when any remain.
   * An `unlisted` client is offered only to reconnect an account whose grant it issued, `reconnecting`.
   */
  const firstPartyClient = (
    discovered: {
      readonly grant: string;
      readonly server: OAuthTokenServer;
      readonly scopes: readonly string[];
      readonly scopesAdvertised?: true | undefined;
    },
    reconnecting?: FirstPartyOAuthClientId,
  ) => {
    if (discovered.grant !== "authorization_code") return undefined;
    const { server } = discovered;
    const same = (declared: string | undefined, configured: string) =>
      declared !== undefined && new URL(declared).href === new URL(configured).href;
    for (const client of firstPartyClients.values()) {
      if (client.unlisted === true && client.id !== reconnecting) continue;
      if (
        !same(server.authorization_endpoint, client.server.authorizationUrl) ||
        !same(server.token_endpoint, client.server.tokenUrl)
      )
        continue;
      const allowed = allowedScopes(client);
      if (discovered.scopesAdvertised === true && discovered.scopes.length > 0) {
        const scopes = discovered.scopes.filter((scope) => allowed.includes(scope));
        if (scopes.length === 0) continue;
        return { client, scopes };
      }
      const scopes = discovered.scopes.length === 0 ? client.defaultScopes : discovered.scopes;
      if (!scopes.every((scope) => allowed.includes(scope))) continue;
      return { client, scopes };
    }
    return undefined;
  };
  const encrypt = (identity: AccountId | OAuthAttemptId | OAuthClientId, value: unknown) =>
    decode(JsonObject, value).pipe(
      Effect.flatMap((value) => credentials.encrypt(identity, Redacted.make(value))),
    );
  const decrypt = <A>(
    identity: AccountId | OAuthAttemptId | OAuthClientId,
    bytes: Uint8Array,
    schema: Schema.Decoder<A>,
  ) =>
    credentials
      .decrypt(identity, Redacted.make(bytes))
      .pipe(Effect.flatMap((value) => decode(schema, Redacted.value(value))));

  /** How a failed discovery is reported to whoever is setting up a sign-in. */
  const discoveryFailed = (error: OAuthProtocolFailed) => {
    const reason = Match.value(error.reason).pipe(
      Match.when("request", () =>
        error.status === 429 ? ("rate_limited" as const) : ("service_unavailable" as const),
      ),
      Match.when("metadata_missing", () => "discovery_missing" as const),
      Match.when("destination_blocked", () => "discovery_blocked" as const),
      Match.when("resource_mismatch", () => "resource_mismatch" as const),
      Match.when("unsupported", () => "unsupported" as const),
      Match.whenOr(
        "invalid_response",
        "invalid_client",
        "invalid_grant",
        () => "discovery_invalid" as const,
      ),
      Match.exhaustive,
    );
    return new OAuthSetupFailed({
      cause: causeOf("discover", error),
      ...retryAfterOf(reason, error),
      reason,
    });
  };

  const resolveSetup = (input: {
    readonly provider: ProviderId;
    readonly method: string;
    readonly redirectUri?: string | undefined;
  }) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthSetupFailed({ reason: "unsupported" });
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", input.provider) }),
      );
      if (row === null) return yield* new ProviderNotFound({ provider: input.provider });
      const provider = yield* decode(Provider, row);
      yield* Effect.annotateCurrentSpan("oauth.provider.id", provider.id);
      const method = Object.hasOwn(provider.definition.auth, input.method)
        ? provider.definition.auth[input.method]
        : undefined;
      if (method === undefined || method.type !== "oauth2")
        return yield* new AuthMethodInvalid({ provider: input.provider, method: input.method });
      const redirect =
        method.grant === "client_credentials" || input.redirectUri === undefined
          ? undefined
          : parseEndpoint(input.redirectUri, options.urlPolicy);
      if (
        method.grant !== "client_credentials" &&
        (redirect === undefined ||
          ["code", "state", "error", "error_description", "error_uri", "iss"].some((key) =>
            redirect.searchParams.has(key),
          ))
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const discovered = yield* protocol.discover(method).pipe(Effect.mapError(discoveryFailed));
      // Import checks report the same choice for the providers they generate.
      const registration =
        discovered.grant === "authorization_code"
          ? clientRegistration(
              discovered.server,
              method.tokenEndpointAuthMethod,
              options.clientMetadataUrl,
            )
          : "manual";
      // Callbacks this host sent before. A client registered at one of them is registered with
      // that callback only; see `signInCallback`.
      const previous =
        redirect === undefined
          ? []
          : (options.previousRedirectUris ?? []).flatMap((uri) => {
              const url = parseEndpoint(uri, options.urlPolicy);
              return url === undefined || url.href === redirect.href ? [] : [url];
            });
      // Stored clients belong to the server the sign-in discovered, not to the provider.
      const issuer = oauthClientIssuer(discovered.server);
      return { method, redirect, discovered, registration, previous, issuer };
    });
  type Resolved = Effect.Success<ReturnType<typeof resolveSetup>>;

  /**
   * What a registered client was registered for, as its registration request said it: the
   * authorization server, the callback (`redirect_uris`, which also decides `application_type`),
   * the scopes (`scope`), the client authentication (`token_endpoint_auth_method`) and the grants
   * (`grant_types`), the last two chosen from the provider's declaration and the server's metadata.
   * The client name is the host's. A server may refuse a scope, callback or method the client was
   * not registered for, so a client is reused only for the same request; the provider and method
   * name are not part of it, so every provider that would send the same request finds the same
   * client.
   */
  const automaticKey = (
    owner: OwnerId,
    callback: URL | undefined,
    resolved: Pick<Resolved, "discovered" | "issuer" | "method">,
  ) =>
    registeredClientKey(hash, {
      owner,
      issuer: resolved.issuer,
      callback: callback?.href,
      scopes: resolved.discovered.scopes,
      tokenEndpointAuthMethod: preferredClientMethod(
        resolved.discovered.server,
        "registered",
        resolved.method.tokenEndpointAuthMethod,
      ),
      grantTypes: registrationGrantTypes(resolved.discovered.server),
    });

  /**
   * A client entered by a person. It authenticates as the provider declares, or with a secret by
   * the method the service prefers; without a secret it is a public client.
   */
  const enteredClient = (
    entered: { readonly clientId: string; readonly clientSecret?: string | undefined },
    discovered: Resolved["discovered"],
  ) =>
    Effect.gen(function* () {
      if (discovered.tokenEndpointAuthMethod === "none" && entered.clientSecret !== undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      return yield* Schema.decodeUnknownEffect(OAuthRegistration)({
        client_id: entered.clientId,
        token_endpoint_auth_method:
          discovered.tokenEndpointAuthMethod ??
          (entered.clientSecret === undefined
            ? "none"
            : secretMethod(discovered.server.token_endpoint_auth_methods_supported)),
        ...(entered.clientSecret === undefined ? {} : { client_secret: entered.clientSecret }),
      }).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
    });

  const clientMetadata = (row: unknown) => decode(OAuthClient, row);
  /** A client's secret expires only when its registration says so. */
  const unexpired = (secret: StoredClientSecret, now: number) =>
    secret.client_secret_expires_at === undefined ||
    secret.client_secret_expires_at === 0 ||
    secret.client_secret_expires_at * 1000 > now;

  /**
   * The callback a sign-in with a stored client sends. A client registered at a callback this
   * host sent before is registered with that callback only, and only the service's owner can
   * change what it allows, so it keeps sending it. Its key, a digest of the settings it was
   * registered for, names the callback; a client without one uses the current callback.
   */
  const signInCallback = (automatic: string | null, owner: OwnerId, resolved: Resolved) =>
    Effect.gen(function* () {
      if (automatic === null) return resolved.redirect;
      for (const candidate of resolved.previous)
        if ((yield* automaticKey(owner, candidate, resolved)) === automatic) return candidate;
      return resolved.redirect;
    });

  /**
   * The owner's stored client for this sign-in's server, or undefined. A client stored before
   * 4.0.12 whose server is not recorded yet is still the one its provider's sign-ins used.
   */
  const storedRow = (id: OAuthClientId, input: ClientScope) =>
    query(() => db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", id) })).pipe(
      Effect.map((row) => (row === null || !inScope(row, input) ? undefined : row)),
    );

  /** The identity of a client's credentials: its owner, issuer, client ID and secret. */
  const digestOf = (
    input: { readonly owner: OwnerId; readonly issuer: string },
    client: { readonly client_id: string; readonly client_secret?: string | undefined },
  ) =>
    credentialsDigest(credentials, {
      owner: input.owner,
      issuer: input.issuer,
      clientId: client.client_id,
      secret: client.client_secret,
    });
  /** A client's identity under its own server, or its provider before that is recorded. */
  const storedDigestOf = (
    row: Pick<StoredClientRow, "owner" | "issuer" | "provider">,
    client: { readonly client_id: string; readonly client_secret?: string | undefined },
  ) =>
    row.issuer !== null
      ? digestOf({ owner: row.owner, issuer: row.issuer }, client)
      : row.provider !== null
        ? legacyCredentialsDigest(credentials, {
            owner: row.owner,
            provider: row.provider,
            clientId: client.client_id,
            secret: client.client_secret,
          })
        : Effect.fail(new StorageError());
  /** A registration's credentials; a public client has no secret, whatever it was issued. */
  const registrationCredentials = (client: OAuthRegistration) => ({
    client_id: client.client_id,
    ...(client.token_endpoint_auth_method === "none" || client.client_secret === undefined
      ? {}
      : { client_secret: client.client_secret }),
  });

  /**
   * Who holds these credentials: the owner's stored client holding them now or before an edit
   * (`held`), a client since removed (`withdrawn`), or none. A client's credentials are that client
   * wherever they are read from, a grant's copy or an entry, so a sign-in using them is authorized
   * as that client, and one using a removed client's fails closed. A grant's `oauthClient` is only
   * a shortcut to the same answer.
   */
  const credentialsHolder = (
    input: ClientScope,
    client: OAuthRegistration,
    /** Another server the credentials were used at, such as the one a reconnected grant names. */
    usedAt?: string,
  ) =>
    Effect.gen(function* () {
      const details = registrationCredentials(client);
      // The digest covers owner and issuer, so it finds only this owner's client for the server.
      const found = yield* credentialsOwner(db, yield* digestOf(input, details));
      if (found !== undefined) return found;
      // Credentials a grant used at another server, if a client there holds them, are that
      // client's, which this sign-in cannot use: they are withdrawn from it.
      if (usedAt !== undefined && usedAt !== input.issuer) {
        const elsewhere = yield* credentialsOwner(
          db,
          yield* digestOf({ owner: input.owner, issuer: usedAt }, details),
        );
        if (elsewhere !== undefined) return unusableHere(elsewhere);
      }
      // Credentials recorded before 4.0.12, under this sign-in's provider: an edited or removed
      // client's earlier credentials, which cannot be recorded under their server.
      const legacy = yield* credentialsOwner(
        db,
        yield* legacyCredentialsDigest(credentials, {
          owner: input.owner,
          provider: input.provider,
          clientId: details.client_id,
          secret: details.client_secret,
        }),
      );
      return legacy === undefined || legacy.kind === "withdrawn" || inScope(legacy.row, input)
        ? legacy
        : unusableHere(legacy);
    });

  /** Whether the product still lets the caller use a stored client; always, without a product. */
  const clientAuthorized = (row: unknown) =>
    lifecycle?.oauthClientResolving === undefined
      ? Effect.succeed(true)
      : clientMetadata(row).pipe(Effect.flatMap(lifecycle.oauthClientResolving));

  /** The owner's stored client a connection names, as its attempt uses it. */
  const storedClient = (id: OAuthClientId, input: SignInScope, resolved: Resolved) =>
    Effect.gen(function* () {
      // A client of another server is not this sign-in's, like another owner's.
      const row = yield* storedRow(id, { ...input, issuer: resolved.issuer });
      if (row === undefined) return yield* new OAuthClientNotFound({ client: id });
      // The caller named this client, so its refusal names it too.
      return yield* useStoredClient(row, input, resolved).pipe(
        Effect.catchTag("OAuthClientNotFound", () => new OAuthClientNotFound({ client: id })),
      );
    });

  /**
   * A stored client as a sign-in uses it, however it was chosen. The product authorizes it first,
   * so its credentials are never read for a caller it no longer admits; a refused client is not
   * found, like another owner's. The refusal carries no ID: a client the sign-in found by itself
   * may be one the caller cannot list.
   */
  const useStoredClient = (row: StoredClientRow, input: SignInScope, resolved: Resolved) =>
    Effect.gen(function* () {
      if (!(yield* clientAuthorized(row))) return yield* new OAuthClientNotFound({});
      // Expiry only stops an automatic client being found again; a named client is used as named,
      // and a service that refuses it discards it at completion.
      const secret = yield* decrypt(row.id, row.encrypted, StoredClientSecret);
      return yield* authorizedClientUse(row, secret, input, resolved);
    });

  /** A stored client the product has authorized for this sign-in, with its decrypted secret. */
  const authorizedClientUse = (
    row: StoredClientRow,
    secret: StoredClientSecret,
    input: SignInScope,
    resolved: Resolved,
  ) =>
    Effect.gen(function* () {
      // Registered clients keep the registration the service issued; entered ones authenticate
      // as this sign-in's discovery says.
      const client =
        (yield* storedRegistration(secret)) ??
        (yield* enteredClient(
          {
            clientId: secret.client_id,
            ...(secret.client_secret === undefined ? {} : { clientSecret: secret.client_secret }),
          },
          resolved.discovered,
        ));
      const use: OAuthClientUse = {
        id: row.id,
        version: Base64.encode(row.encrypted),
        source: row.source,
        fresh: !row.confirmed,
      };
      return {
        client,
        use,
        callback: yield* signInCallback(row.automaticKey, input.owner, resolved),
      };
    });

  /**
   * The owner's registered client for a sign-in's settings: the first the product authorizes for
   * the caller whose secret has not expired, or else the first it refuses. A client a person
   * registered is used only when a connection names it, so whoever may use it is the host's
   * decision. Executor can register again at the current callback, so one registered at an earlier
   * callback is used only when the service no longer registers clients.
   *
   * The product decides before anything reads a client's credentials, so a caller it refuses never
   * causes a secret to be decrypted, and never discards a client. Expired registrations can never
   * sign in again, so an authorized caller discards them; one refused to the caller stays until an
   * authorized sign-in reaches it.
   */
  const existingAutomatic = (owner: OwnerId, resolved: Resolved) =>
    Effect.gen(function* () {
      const { redirect, discovered, registration, previous } = resolved;
      if (discovered.grant !== "authorization_code" || redirect === undefined) return undefined;
      let refused: StoredClientRow | undefined;
      for (const candidate of registration === "manual" ? [redirect, ...previous] : [redirect]) {
        const key = yield* automaticKey(owner, candidate, resolved);
        const rows = yield* query(() =>
          db.findMany("storedOAuthClients", {
            where: (b) =>
              b.and(
                b("owner", "=", owner),
                b("automaticKey", "=", key),
                b("source", "=", "registered"),
              ),
            orderBy: ["createdAt", "asc"],
          }),
        );
        for (const row of rows) {
          if (!(yield* clientAuthorized(row))) {
            refused ??= row;
            continue;
          }
          const secret = yield* decrypt(row.id, row.encrypted, StoredClientSecret);
          if (unexpired(secret, yield* Clock.currentTimeMillis))
            return { kind: "authorized" as const, row, secret };
          // Discarding one withdraws its credentials, so a sign-in pending with it fails closed.
          yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              yield* query(() =>
                tx.deleteMany("storedOAuthClients", {
                  where: (b) => b.and(b("id", "=", row.id), b("encrypted", "=", row.encrypted)),
                }),
              );
              yield* withdrawCredentials(tx, row.id, "expired");
            }),
          );
        }
      }
      return refused === undefined ? undefined : { kind: "refused" as const, row: refused };
    });

  /**
   * Automatic when the owner has a registered client for these settings, the operator's client
   * fits, or the service accepts the host's metadata document or registers clients. Reading
   * setup never registers a client.
   */
  const oauthSetup = (input: typeof CheckOAuthSetup.Type) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSetup(input);
      const { discovered, method, registration } = resolved;
      // A registered client the caller is refused still counts, as a start finds it too.
      const existing = yield* existingAutomatic(input.owner, resolved);
      // The operator's own client, after the owner's registered clients and before CIMD and DCR.
      const firstParty = existing === undefined ? firstPartyClient(discovered) : undefined;
      const mode =
        existing === undefined && firstParty === undefined && registration === "manual"
          ? ("client-required" as const)
          : ("automatic" as const);
      if (method.grant === "client_credentials")
        return {
          mode,
          scopes: discovered.scopes,
          grant: method.grant,
          tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
        } satisfies OAuthClientSetup;
      const operator =
        firstParty === undefined ? {} : { firstParty: { label: firstParty.client.label } };
      // The operator's client signs in with its own server, parameters and scopes, see
      // `beginFirstParty`; any other client with the provider's.
      const user =
        firstParty !== undefined
          ? userScopes(
              firstParty.client.server.authorizationUrl,
              firstParty.client.server.authorizationParams,
            )
          : discovered.grant === "authorization_code"
            ? userScopes(discovered.server.authorization_endpoint, discovered.authorizationParams)
            : [];
      return {
        mode,
        scopes: firstParty?.scopes ?? discovered.scopes,
        grant: "authorization_code",
        issuer: HttpUrl.make(resolved.issuer),
        ...operator,
        ...(discovered.tokenEndpointAuthMethod === undefined
          ? {}
          : { tokenEndpointAuthMethod: discovered.tokenEndpointAuthMethod }),
        ...(user.length === 0 ? {} : { userScopes: user }),
      } satisfies OAuthClientSetup;
    }).pipe(Effect.withSpan("oauth.setup"));

  /**
   * Insert a stored client holding these credentials and let the host record its access, in the
   * caller's transaction. Credentials another client holds or held are never stored twice: the
   * result is then that client's ID, and nothing is written.
   */
  const createStoredClient = (store: Query, row: StoredClientRow, digest: string) =>
    Effect.gen(function* () {
      const holder = yield* claimCredentials(store, {
        digest,
        owner: row.owner,
        provider: row.provider,
        client: row.id,
        createdAt: row.createdAt,
        reclaim: true,
      });
      if (holder !== undefined) return { stored: false as const, holder };
      yield* query(() => store.create("storedOAuthClients", row));
      const client = yield* clientMetadata(row);
      if (lifecycle?.oauthClientCreated) yield* lifecycle.oauthClientCreated(client);
      return { stored: true as const, client };
    });

  /** Register a client entered by a person for browser sign-in at one authorization server. */
  const registerClient = (input: typeof OAuthClientInputs.register.Type) =>
    Effect.gen(function* () {
      const id = OAuthClientId.make(`oac_${yield* nextId}`);
      const secret =
        input.clientSecret === undefined ? undefined : Redacted.value(input.clientSecret);
      const encrypted = yield* encrypt(id, {
        client_id: input.clientId,
        ...(secret === undefined ? {} : { client_secret: secret }),
      });
      const createdAt = new Date(yield* Clock.currentTimeMillis);
      const digest = yield* digestOf(input, {
        client_id: input.clientId,
        ...(secret === undefined ? {} : { client_secret: secret }),
      });
      const result = yield* transaction(db, (tx) =>
        createStoredClient(
          tx,
          {
            id,
            owner: input.owner,
            provider: null,
            issuer: input.issuer,
            clientId: input.clientId,
            source: "manual",
            hasSecret: secret !== undefined,
            automaticKey: null,
            confirmed: false,
            encrypted,
            createdAt,
          },
          digest,
        ),
      );
      if (!result.stored) return yield* new OAuthClientExists({ client: result.holder });
      return result.client;
    }).pipe(Effect.withSpan("oauth.clients.register"));

  const ownedClient = (input: typeof OAuthClientInputs.get.Type) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", input.client) }),
      );
      if (row === null || row.owner !== input.owner)
        return yield* new OAuthClientNotFound({ client: input.client });
      return row;
    });

  /**
   * Change a registered client's ID or secret. Grants hold their own copy of the client, so only
   * new connections and reconnects use the change. The new details have not signed in yet. The
   * old credentials stay this client's, so a reconnect with a grant's copy of them is still
   * authorized as it. Read and written in one transaction, which a host's own transaction around
   * the call joins.
   */
  const updateClient = (input: typeof OAuthClientInputs.update.Type) =>
    transaction(db, () => updateClientDetails(input)).pipe(Effect.withSpan("oauth.clients.update"));
  const updateClientDetails = (input: typeof OAuthClientInputs.update.Type) =>
    Effect.gen(function* () {
      const row = yield* ownedClient(input);
      if (row.source !== "manual") return yield* new OAuthClientNotEditable({ client: row.id });
      const current = yield* decrypt(row.id, row.encrypted, StoredClientSecret);
      const clientId = input.clientId ?? current.client_id;
      const secret =
        input.clientSecret === undefined
          ? current.client_secret
          : Redacted.value(input.clientSecret);
      if (clientId === current.client_id && secret === current.client_secret)
        return yield* clientMetadata(row);
      const updated = { clientId, hasSecret: secret !== undefined };
      const details = {
        client_id: clientId,
        ...(secret === undefined ? {} : { client_secret: secret }),
      };
      const encrypted = yield* encrypt(row.id, details);
      const holder = yield* claimCredentials(db, {
        digest: yield* storedDigestOf(row, details),
        owner: row.owner,
        // A client stored before 4.0.12 keeps its credentials' earlier identity until its server
        // is recorded.
        provider: row.issuer === null ? row.provider : null,
        client: row.id,
        createdAt: new Date(yield* Clock.currentTimeMillis),
        reclaim: true,
      });
      if (holder !== undefined) return yield* new OAuthClientExists({ client: holder });
      // New details are a new registration at the service, made for the current callback.
      yield* query(() =>
        db.updateMany("storedOAuthClients", {
          where: (b) => b.and(b("id", "=", row.id), b("owner", "=", input.owner)),
          set: { ...updated, automaticKey: null, confirmed: false, encrypted },
        }),
      );
      return yield* clientMetadata({ ...row, ...updated });
    });

  /**
   * The authorization server each browser sign-in method of a provider uses, discovered as its
   * sign-in discovers it, so a client registered for it is offered to that sign-in.
   */
  const issuers = (input: typeof OAuthClientInputs.issuers.Type) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("providers", { where: (b) => b("id", "=", input.provider) }),
      );
      if (row === null) return yield* new ProviderNotFound({ provider: input.provider });
      const provider = yield* decode(Provider, row);
      const methods = Object.entries(provider.definition.auth).flatMap(([name, method]) =>
        method.type === "oauth2" && method.grant !== "client_credentials" ? [{ name, method }] : [],
      );
      if (methods.length === 0)
        return yield* new OAuthClientsUnsupported({ provider: input.provider });
      if (protocol === undefined) return yield* new OAuthSetupFailed({ reason: "unsupported" });
      return yield* Effect.forEach(methods, ({ name, method }) =>
        protocol.discover(method).pipe(
          Effect.mapError(discoveryFailed),
          Effect.map((discovered) => ({
            method: name,
            issuer: HttpUrl.make(oauthClientIssuer(discovered.server)),
          })),
        ),
      );
    }).pipe(Effect.withSpan("oauth.clients.issuers"));

  const clients = {
    register: registerClient,
    issuers,
    list: (input: typeof OAuthClientInputs.list.Type) =>
      query(() =>
        db.findMany("storedOAuthClients", {
          where: (b) =>
            b.and(
              b("owner", "=", input.owner),
              input.issuer === undefined ? true : b("issuer", "=", input.issuer),
            ),
          orderBy: ["createdAt", "asc"],
        }),
      ).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, clientMetadata)),
        Effect.withSpan("oauth.clients.list"),
      ),
    get: (input: typeof OAuthClientInputs.get.Type) =>
      ownedClient(input).pipe(Effect.flatMap(clientMetadata), Effect.withSpan("oauth.clients.get")),
    update: updateClient,
    // The client's credentials stay recorded as its, withdrawn by this removal: a sign-in with a
    // grant's copy of them, or one pending with the client, fails closed rather than use
    // credentials withdrawn from everyone. Whatever kind of client it was.
    remove: (input: typeof OAuthClientInputs.remove.Type) =>
      transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* ownedClient(input);
          yield* query(() =>
            tx.deleteMany("storedOAuthClients", {
              where: (b) => b.and(b("id", "=", input.client), b("owner", "=", input.owner)),
            }),
          );
          yield* withdrawCredentials(tx, input.client, "removed");
          return { client: input.client };
        }),
      ).pipe(Effect.withSpan("oauth.clients.remove")),
  };

  /**
   * The callback a sign-in as `client` sends: the one the host's document lists for the
   * document's client, which the server holds the sign-in to, and the sign-in's own for any other.
   */
  const clientCallback = (client: OAuthRegistration, redirect: URL | undefined) => {
    const document =
      options?.clientMetadataUrl === undefined
        ? undefined
        : parseDestination(options.clientMetadataUrl, httpsOnlyUrlPolicy);
    return document === undefined ||
      client.client_id !== document.href ||
      options?.clientMetadataRedirectUri === undefined
      ? redirect
      : parseEndpoint(options.clientMetadataRedirectUri, options.urlPolicy);
  };

  /**
   * The automatic client for a sign-in, in MCP's order after the owner's own: a client the owner
   * already registered for these settings, the operator's client, the host's client metadata
   * document, then a client registered now. It uses the sign-in's own discovery rather than
   * discovering the service again. A newly registered client is stored at once, since the service
   * has already issued it; a document client is the host's configuration and is never stored.
   * `reconnecting` names the operator's client that issued the grant a reconnect replaces, which
   * is offered even when it is unlisted.
   */
  const automaticChoice = (
    input: SignInScope,
    resolved: Resolved,
    reconnecting?: FirstPartyOAuthClientId,
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthClientUnavailable(input);
      const { method, redirect, discovered, registration } = resolved;
      const existing = yield* existingAutomatic(input.owner, resolved);
      if (existing?.kind === "refused") return yield* new OAuthClientNotFound({});
      if (existing !== undefined)
        return {
          kind: "stored" as const,
          ...(yield* authorizedClientUse(existing.row, existing.secret, input, resolved)),
        };
      const firstParty = firstPartyClient(discovered, reconnecting);
      if (firstParty !== undefined) return { kind: "firstParty" as const, firstParty };
      if (registration === "client_id_metadata_document") {
        const url =
          options.clientMetadataUrl === undefined
            ? undefined
            : parseDestination(options.clientMetadataUrl, httpsOnlyUrlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        const client: OAuthRegistration = {
          client_id: url.href,
          token_endpoint_auth_method: "none",
        };
        return { kind: "entered" as const, client, callback: clientCallback(client, redirect) };
      }
      if (discovered.grant !== "authorization_code" || registration !== "dynamic")
        return yield* new OAuthClientUnavailable(input);
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const client = yield* protocol
        .register(discovered.server, redirect, discovered.scopes, method.tokenEndpointAuthMethod)
        .pipe(Effect.mapError((error) => registrationFailed(error, HttpUrl.make(redirect.href))));
      if (
        client.token_endpoint_auth_method === "client_secret_basic_raw" &&
        client.client_id.includes(":")
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      const id = OAuthClientId.make(`oac_${yield* nextId}`);
      const encrypted = yield* encrypt(id, client);
      const key = yield* automaticKey(input.owner, redirect, resolved);
      const row: StoredClientRow = {
        id,
        owner: input.owner,
        provider: null,
        issuer: resolved.issuer,
        clientId: client.client_id,
        source: "registered",
        hasSecret: client.token_endpoint_auth_method !== "none",
        automaticKey: key,
        confirmed: false,
        encrypted,
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      const scope = { ...input, issuer: resolved.issuer };
      const digest = yield* digestOf(scope, registrationCredentials(client));
      const stored = yield* transaction(db, (tx) => createStoredClient(tx, row, digest));
      // A service that issued credentials a stored client already holds issued that client.
      const used = stored.stored ? row : yield* storedRow(stored.holder, scope);
      if (used === undefined) return yield* new OAuthClientNotFound({});
      // A client registered now is a stored client like any other: the product authorizes it
      // before this sign-in uses it, as it will for every later one.
      return { kind: "stored" as const, ...(yield* useStoredClient(used, input, resolved)) };
    }).pipe(Effect.withSpan("oauth.clients.automatic"));

  /**
   * The client a sign-in uses. Without a choice, a reconnect keeps the stored client its account
   * signed in with, while that client exists and the product admits the caller to it; otherwise
   * the sign-in is automatic, and a reconnect the service offers no automatic client for reuses
   * the copy its grant holds. Credentials a stored client holds, from a grant or entered, are
   * always used as that client.
   */
  const chooseClient = (
    input: typeof StartConnectionOAuth.Type & {
      readonly owner: OwnerId;
      readonly provider: ProviderId;
    },
    resolved: Resolved,
    existing: Account | undefined,
  ) =>
    Effect.gen(function* () {
      const { discovered, redirect } = resolved;
      const choice = input.client;
      const scope: ClientScope = { ...input, issuer: resolved.issuer };
      const automatic = choice === undefined || Schema.is(OAuthAutomaticClient)(choice);
      const row =
        existing === undefined || !automatic
          ? null
          : yield* query(() =>
              db.findFirst("oauthGrants", { where: (b) => b("id", "=", existing.id) }),
            );
      const previous =
        existing === undefined || row === null
          ? undefined
          : yield* decrypt(existing.id, row.encrypted, OAuthGrant);
      // The operator's client that issued the grant this reconnect replaces, offered again even
      // when it is unlisted.
      const reconnecting =
        previous !== undefined && isFirstPartyGrant(previous) ? previous.firstParty : undefined;
      if (choice === undefined) {
        const reusable =
          previous === undefined ||
          isFirstPartyGrant(previous) ||
          (previous.grant ?? "authorization_code") !== discovered.grant
            ? undefined
            : previous;
        // The stored client the grant signed in with: the one it names, or the one holding or
        // having held the copy it keeps, however the grant was written.
        const named =
          reusable === undefined ||
          reusable.grant === "client_credentials" ||
          reusable.oauthClient === undefined
            ? undefined
            : yield* storedRow(reusable.oauthClient, scope);
        const holder =
          named !== undefined
            ? ({ kind: "held", row: named } as const)
            : reusable === undefined || reusable.grant === "client_credentials"
              ? undefined
              : yield* credentialsHolder(
                  scope,
                  reusable.client,
                  oauthClientIssuer(reusable.server),
                );
        // A removed client's credentials are withdrawn: the reconnect signs in automatically or
        // needs another client, and never reuses the grant's copy of them.
        if (holder?.kind === "withdrawn")
          return yield* automaticChoice(input, resolved, reconnecting).pipe(
            Effect.catchTag("OAuthClientUnavailable", () =>
              Effect.fail(new OAuthClientNotFound({})),
            ),
          );
        const kept = holder?.row;
        if (kept !== undefined) {
          const keep = useStoredClient(kept, input, resolved).pipe(
            Effect.map((use) => ({ kind: "stored" as const, ...use })),
          );
          // A client a person registered is kept while the product still admits the caller. A
          // registered client is automatic: the sign-in finds it again while it is usable, and
          // keeps it when the service offers no other. Either way a refusal fails rather than
          // fall back to the copy the grant holds of the same client.
          if (kept.source === "manual") return yield* keep;
          return yield* automaticChoice(input, resolved, reconnecting).pipe(
            Effect.catchTag("OAuthClientUnavailable", () => keep),
          );
        }
        // No stored client holds or held the grant's copy, so reusing it uses no stored client's
        // credentials. Completion checks again, in case one is stored meanwhile.
        return yield* automaticChoice(input, resolved, reconnecting).pipe(
          Effect.catchTag("OAuthClientUnavailable", (error) =>
            reusable === undefined
              ? Effect.fail(error)
              : Effect.succeed({
                  kind: "entered" as const,
                  client: reusable.client,
                  callback: clientCallback(reusable.client, redirect),
                }),
          ),
        );
      }
      if (Schema.is(OAuthClientReference)(choice)) {
        // A client credentials client is the account itself, so it is never stored or shared.
        if (discovered.grant === "client_credentials")
          return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        return { kind: "stored" as const, ...(yield* storedClient(choice.id, input, resolved)) };
      }
      if (Schema.is(OAuthAutomaticClient)(choice))
        return yield* automaticChoice(input, resolved, reconnecting);
      if (choice.save === true && discovered.grant === "client_credentials")
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      const client = yield* enteredClient(
        {
          clientId: choice.clientId,
          ...(choice.clientSecret === undefined
            ? {}
            : { clientSecret: Redacted.value(choice.clientSecret) }),
        },
        discovered,
      );
      // Entered credentials a stored client holds or held are that client, authorized as it and
      // used with its current details; saving them again would only duplicate it. Those of a
      // removed client are withdrawn.
      if (discovered.grant !== "client_credentials") {
        const holder = yield* credentialsHolder(scope, client);
        if (holder?.kind === "withdrawn") return yield* new OAuthClientNotFound({});
        if (holder !== undefined)
          return {
            kind: "stored" as const,
            ...(yield* useStoredClient(holder.row, input, resolved)),
          };
      }
      return {
        kind: "entered" as const,
        client,
        callback: redirect,
        ...(choice.save === true ? { save: true as const } : {}),
      };
    });

  const beginOAuth = (
    input: typeof StartConnectionOAuth.Type & {
      readonly owner: OwnerId;
      readonly provider: ProviderId;
    },
    existing?: Account,
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthClientUnavailable(input);
      const resolved = yield* resolveSetup(input);
      const { method, discovered } = resolved;
      const chosen = yield* chooseClient(input, resolved, existing);
      if (chosen.kind === "firstParty")
        return yield* beginFirstParty(
          input,
          existing,
          chosen.firstParty,
          resolved.redirect,
          method.response,
        );
      const stored = chosen.kind === "stored" ? chosen.use : undefined;
      const save = "save" in chosen && chosen.save === true;
      const redirect = chosen.callback;
      const client = chosen.client;
      if (
        client.token_endpoint_auth_method === "client_secret_basic_raw" &&
        client.client_id.includes(":")
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      const registered = client;
      if (discovered.grant === "client_credentials") {
        const confidential = yield* Schema.decodeUnknownEffect(OAuthConfidentialRegistration)(
          registered,
        ).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
        const tokens = yield* protocol
          .clientCredentials({ ...discovered, client: confidential })
          .pipe(Effect.mapError(clientCredentialsFailed));
        const fields = yield* project(method.response, tokens).pipe(
          Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })),
        );
        const completedAt = yield* Clock.currentTimeMillis;
        const account = existing ?? {
          id: AccountId.make(`acc_${yield* nextId}`),
          owner: input.owner,
          provider: input.provider,
          method: input.method,
          createdAt: new Date(completedAt),
        };
        const grant = yield* decode(OAuthGrant, {
          ...discovered,
          client: confidential,
          fields,
          response: method.response,
          ...expiry(completedAt, tokens.expires_in),
        });
        const encryptedCredentials = yield* encrypt(account.id, fields);
        const encryptedGrant = yield* encrypt(account.id, grant);
        const ready = `ready_${yield* nextId}`;
        const saved = yield* transaction(db, (tx) =>
          Effect.gen(function* () {
            const current = yield* lockConnection(tx, input, crypto);
            if (current.state.status === "completed") return current.state.account;
            const claimed = yield* requireOpen(input, current);
            const stored =
              existing === undefined
                ? undefined
                : yield* ownedAccount(tx, { account: account.id, owner: input.owner });
            const saved = stored ?? {
              ...account,
              label: input.label ?? (yield* defaultLabel(tx, input.owner, input.provider)),
              description: null,
            };
            if (stored === undefined) {
              yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
              if (lifecycle) yield* lifecycle.accountCreated(saved);
            } else
              // Connecting an existing account again starts a new credential generation.
              yield* query(() =>
                tx.updateMany("accounts", {
                  where: (b) => b("id", "=", stored.id),
                  set: {
                    encryptedCredentials,
                    credentialGeneration: stored.credentialGeneration + 1,
                  },
                }),
              );
            const state = {
              encrypted: encryptedGrant,
              status: ready,
              updatedAt: new Date(completedAt),
            };
            yield* query(() =>
              tx.upsert("oauthGrants", {
                where: (b) => b("id", "=", saved.id),
                create: { id: saved.id, ...state },
                update: state,
              }),
            );
            if (lifecycle)
              yield* lifecycle.connectionCompleting({
                id: current.id,
                owner: current.owner,
                reconnectAccount: current.reconnectAccount,
                target: { app: current.target.app, requirement: current.target.requirement },
              });
            yield* finishConnection(tx, claimed, saved, lifecycle);
            return saved;
          }),
        );
        return { status: "completed" as const, account: saved };
      }
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const authorization = yield* protocol
        .authorize({ ...discovered, client: registered, redirectUri: redirect.href })
        .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "unsupported" })));
      const id = OAuthAttemptId.make(`oauth_${yield* hash(authorization.state)}`);
      const account = existing?.id ?? AccountId.make(`acc_${yield* nextId}`);
      const attempt = yield* decode(OAuthAttempt, {
        ...input,
        ...authorization,
        ...discovered,
        redirectUri: redirect.href,
        account,
        ...(existing === undefined ? {} : { reconnect: true }),
        client: registered,
        ...(stored === undefined ? {} : { storedClient: stored }),
        ...(save ? { saveClient: true } : {}),
        response: method.response,
      });
      return yield* saveAttempt(input, id, attempt, authorization.authorizationUrl);
    }).pipe(Effect.withSpan("oauth.beginOAuth"));

  /** Save a sign-in attempt for the connection and send the browser to its authorization URL. */
  const saveAttempt = (
    input: typeof StartConnectionOAuth.Type & { readonly owner: OwnerId },
    id: OAuthAttemptId,
    attempt: typeof OAuthAttemptRecord.Type,
    authorizationUrl: string,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const encrypted = yield* encrypt(id, attempt);
      const pending = yield* openConnection(db, input);
      const expiresAt = new Date(Math.min(now + 10 * 60_000, pending.expiresAt.getTime()));
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const current = yield* requireOpen(input, yield* lockConnection(tx, input, crypto));
          yield* query(() =>
            tx.create("oauthAttempts", { id, encrypted, expiresAt, status: "pending" }),
          );
          yield* startSignIn(tx, current, id);
        }),
      );
      return {
        status: "redirect" as const,
        authorizationUrl: HttpUrl.make(authorizationUrl),
        expiresAt,
        redirectUri: HttpUrl.make(attempt.redirectUri),
        ...(isFirstPartyAttempt(attempt) || attempt.storedClient === undefined
          ? {}
          : { oauthClient: attempt.storedClient.id }),
      };
    });

  /**
   * Start a sign-in with the operator's client. Everything sent goes where the operator configured
   * and as it configured, scope separator and extra parameters included; the scopes are the
   * provider's, or the client's defaults, already checked against `allowedScopes`. The attempt
   * keeps the client's ID and none of its configuration.
   */
  const beginFirstParty = (
    input: typeof StartConnectionOAuth.Type & {
      readonly owner: OwnerId;
      readonly provider: ProviderId;
    },
    existing: Account | undefined,
    firstParty: { readonly client: FirstPartyOAuthClient; readonly scopes: readonly string[] },
    redirect: URL | undefined,
    response: JsonObject,
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined) return yield* new OAuthClientUnavailable(input);
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const operator = yield* operatorClient(firstParty.client.id);
      if (operator === undefined) return yield* new OAuthClientUnavailable(input);
      const { scopeSeparator, authorizationParams, resource } = firstParty.client.server;
      const authorization = yield* protocol
        .authorize({
          server: operator.server,
          client: operator.client,
          redirectUri: redirect.href,
          scopes: firstParty.scopes,
          ...(scopeSeparator === undefined ? {} : { scopeSeparator }),
          ...(authorizationParams === undefined ? {} : { authorizationParams }),
          ...(resource === undefined ? {} : { resource }),
        })
        .pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "unsupported" })));
      const id = OAuthAttemptId.make(`oauth_${yield* hash(authorization.state)}`);
      const attempt = yield* decode(OAuthFirstPartyAttempt, {
        ...input,
        ...authorization,
        redirectUri: redirect.href,
        account: existing?.id ?? AccountId.make(`acc_${yield* nextId}`),
        ...(existing === undefined ? {} : { reconnect: true }),
        firstParty: firstParty.client.id,
        response,
      });
      return yield* saveAttempt(input, id, attempt, authorization.authorizationUrl);
    }).pipe(Effect.withSpan("oauth.beginFirstParty"));

  const startOAuth = (input: typeof StartConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const saved = yield* readConnection(db, input);
      if (saved.state.status === "completed")
        return { status: "completed" as const, account: saved.state.account };
      const connection = yield* requireOpen(input, saved);
      // Never discover or register a client for a provider the target app no longer requires.
      yield* requireTargetProvider(db, connection);
      const existing =
        connection.reconnectAccount === null
          ? undefined
          : yield* ownedAccount(db, {
              account: connection.reconnectAccount,
              owner: connection.owner,
            });
      if (existing !== undefined && existing.method !== input.method)
        return yield* new AuthMethodInvalid({
          provider: connection.provider,
          method: input.method,
        });
      const { label: requested, ...rest } = input;
      const label = existing?.label ?? requested;
      return yield* beginOAuth(
        {
          ...rest,
          owner: connection.owner,
          provider: connection.provider,
          // Attempts are encrypted as JSON, so an unnamed account omits the key.
          ...(label === undefined ? {} : { label }),
        },
        existing,
      ).pipe(
        // Agents reading the request learn what the person connecting was shown.
        Effect.tapError((error) =>
          Schema.is(OAuthSetupFailed)(error)
            ? recordSignInFailure(db, crypto, input, connection.oauthAttempt, error)
            : Effect.void,
        ),
      );
    }).pipe(Effect.withSpan("oauth.startOAuth"));

  const reconnectTarget = (tx: Query, attempt: typeof OAuthAttemptRecord.Type) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        tx.findFirst("accounts", { where: (b) => b("id", "=", attempt.account) }),
      );
      if (
        row === null ||
        row.owner !== attempt.owner ||
        row.provider !== attempt.provider ||
        row.method !== attempt.method
      ) {
        return yield* new OAuthCompletionFailed({ reason: "account_unavailable" });
      }
      return yield* decode(StoredAccount, row);
    });

  const failed = (reason: OAuthCompletionReason) => new OAuthCompletionFailed({ reason });
  /** Reject the returned authorization response, recording which part failed. */
  const rejected = (
    reason: OAuthCompletionReason,
    field: OAuthCallbackField,
    detail: OAuthFailureDetail,
  ) =>
    Effect.annotateCurrentSpan({
      "oauth.error.stage": "authorize",
      "oauth.error.callback_field": field,
      "oauth.error.detail": detail,
    }).pipe(Effect.andThen(Effect.fail(failed(reason))));
  /** The callback's one-time state is the only key to its pending sign-in. */
  const pendingAttempt = (callbackUrl: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const received = Redacted.value(callbackUrl);
      if (!URL.canParse(received))
        return yield* rejected("callback_malformed", "callback_url", "callback_unparseable");
      const callback = new URL(received);
      const states = callback.searchParams.getAll("state");
      const state = states[0];
      if (state === undefined)
        return yield* rejected("callback_malformed", "state", "callback_state_missing");
      if (states.length !== 1)
        return yield* rejected("callback_malformed", "state", "callback_state_repeated");
      if (state.length < 32)
        return yield* rejected("callback_malformed", "state", "callback_state_short");
      if (callback.href.includes("#"))
        return yield* rejected("callback_malformed", "callback_url", "callback_fragment");
      if (callback.username !== "" || callback.password !== "")
        return yield* rejected("callback_malformed", "callback_url", "callback_credentials");
      const id = OAuthAttemptId.make(`oauth_${yield* hash(state)}`);
      const row = yield* query(() =>
        db.findFirst("oauthAttempts", { where: (b) => b("id", "=", id) }),
      );
      if (row === null)
        return yield* rejected("sign_in_not_found", "state", "callback_attempt_not_found");
      // Claimed and completed attempts are never reopened, including after a failed completion.
      if (row.status !== "pending") return yield* failed("sign_in_used");
      const now = yield* Clock.currentTimeMillis;
      if (row.expiresAt.getTime() <= now) return yield* failed("sign_in_expired");
      const raw = yield* decrypt(id, row.encrypted, JsonObject);
      const attempt = yield* decode(OAuthAttemptRecord, raw);
      yield* Effect.annotateCurrentSpan("oauth.provider.id", attempt.provider);
      // A sign-in started before 4.0.10 with a saved client names it as `savedClient`, which this
      // version does not read. That client is now a stored client the product authorizes, so
      // such an attempt is never completed with the copy it holds; see exchangeClaimed.
      return { callback, id, attempt, legacySavedClient: Object.hasOwn(raw, "savedClient") };
    });

  /** Another owner's sign-in is indistinguishable from an unknown one. */
  const findOAuth = (input: typeof FindConnectionOAuth.Type) =>
    pendingAttempt(input.callbackUrl).pipe(
      Effect.flatMap(({ attempt }) =>
        input.owner !== undefined && attempt.owner !== input.owner
          ? rejected("sign_in_not_found", "state", "callback_attempt_not_found")
          : Effect.succeed({
              owner: attempt.owner,
              connection: attempt.connection,
              redirectUri: attempt.redirectUri,
            }),
      ),
      Effect.tapError((error) =>
        Schema.is(OAuthCompletionFailed)(error)
          ? Effect.annotateCurrentSpan("oauth.completion.reason", error.reason)
          : Effect.void,
      ),
      Effect.withSpan("oauth.findOAuth"),
    );

  const completeOAuth = (input: typeof CompleteConnectionOAuth.Type) =>
    Effect.gen(function* () {
      const connectionState = yield* readConnection(db, input);
      if (connectionState.state.status === "completed") return connectionState.state.account;
      if (protocol === undefined) return yield* failed("oauth_unavailable");
      const { callback, id, attempt, legacySavedClient } = yield* pendingAttempt(input.callbackUrl);
      // This browser, or this connection, has since started a newer sign-in.
      if (attempt.connection !== input.connection) return yield* failed("sign_in_replaced");
      const connection = yield* openConnection(db, input);
      if (connection.oauthAttempt !== id) return yield* failed("sign_in_replaced");
      const redirect = new URL(attempt.redirectUri);
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        [...redirect.searchParams.keys()].some((key) => {
          const expected = redirect.searchParams.getAll(key);
          const actual = callback.searchParams.getAll(key);
          return (
            expected.length !== actual.length ||
            expected.some((value, index) => actual[index] !== value)
          );
        })
      )
        return yield* rejected("redirect_mismatch", "redirect_uri", "callback_redirect_mismatch");
      const claim = `claim_${yield* nextId}`;
      // Conditional UPDATE is atomic even on adapters without row locks or update counts.
      yield* query(() =>
        db.updateMany("oauthAttempts", {
          where: (b) => b.and(b("id", "=", id), b("status", "=", "pending")),
          set: { status: claim },
        }),
      );
      const claimed = yield* query(() =>
        db.findFirst("oauthAttempts", { where: (b) => b("id", "=", id) }),
      );
      if (claimed?.status !== claim) return yield* failed("sign_in_used");
      // This completion owns the sign-in now, so whatever ends it is the request's latest outcome,
      // including a refusal or changed target that rolled back the account it signed in to: the
      // claimed sign-in cannot complete again, so the request reads failed until a new one starts.
      return yield* exchangeClaimed(protocol, input, callback, id, attempt, legacySavedClient).pipe(
        Effect.tapError((error) =>
          Schema.is(OAuthCompletionFailed)(error) ||
          Schema.is(AccountConnectionRefused)(error) ||
          Schema.is(AccountConnectionTargetChanged)(error)
            ? recordSignInFailure(db, crypto, input, id, error)
            : Effect.void,
        ),
      );
    }).pipe(
      Effect.tapError((error) =>
        Schema.is(OAuthCompletionFailed)(error)
          ? Effect.annotateCurrentSpan("oauth.completion.reason", error.reason)
          : Effect.void,
      ),
      Effect.withSpan("oauth.completeOAuth"),
    );

  /** Validate the authorization response this completion claimed, exchange its code and save. */
  const exchangeClaimed = (
    protocol: ReturnType<typeof makeOAuthProtocol>,
    input: typeof CompleteConnectionOAuth.Type,
    callback: URL,
    id: OAuthAttemptId,
    attempt: typeof OAuthAttemptRecord.Type,
    legacySavedClient: boolean,
  ) =>
    Effect.gen(function* () {
      if (attempt.reconnect) yield* reconnectTarget(db, attempt);
      // An attempt with the operator's client signs in with its current configuration only.
      const operating = isFirstPartyAttempt(attempt)
        ? yield* operatorClient(attempt.firstParty).pipe(
            Effect.map((operator) =>
              operator === undefined ? undefined : { ...attempt, ...operator },
            ),
          )
        : attempt;
      if (operating === undefined)
        return yield* new OAuthCompletionFailed({
          reason: "invalid_client",
          cause: { stage: "exchange" },
        });
      // A sign-in started before 4.0.10 with a saved client cannot be authorized: it names no
      // stored client. Sign-ins last ten minutes, so it fails closed and the person starts again.
      if (legacySavedClient) return yield* failed("client_unavailable");
      const storedRef = isFirstPartyAttempt(attempt) ? undefined : attempt.storedClient;
      // The server this sign-in signs in at, whose clients its credentials belong to.
      const scope: ClientScope | undefined = isFirstPartyAttempt(attempt)
        ? undefined
        : { ...attempt, issuer: oauthClientIssuer(attempt.server) };
      // Who may use a stored client can change while the browser is at the service: the product,
      // when it decides that, authorizes it again before its code is exchanged.
      const named =
        storedRef === undefined || scope === undefined
          ? undefined
          : yield* storedRow(storedRef.id, scope);
      if (named !== undefined && !(yield* clientAuthorized(named)))
        return yield* failed("client_unavailable");
      // Otherwise the credentials the attempt holds decide, read where their client recorded them.
      // An attempt that started with credentials no stored client held, such as a reconnect
      // reusing its grant's copy, may find them stored since, as when data step
      // 6_stored_oauth_clients moves a saved client during consent. So may one whose client is
      // gone and whose credentials were registered again. They are that client now, so the product
      // authorizes it like any other, and the grant names it.
      const holder =
        isFirstPartyAttempt(attempt) || scope === undefined || named !== undefined
          ? undefined
          : yield* credentialsHolder(scope, attempt.client);
      // A client that is gone withdrew its credentials, and the attempt fails closed without the
      // product being asked or the code exchanged, since there is nothing left to authorize: a
      // person removed it, or Executor discarded it. Its stored client gone with no record of its
      // credentials (its owner removed) fails closed too.
      if (storedRef !== undefined && holder === undefined && named === undefined)
        return yield* failed("client_unavailable");
      if (holder?.kind === "withdrawn") {
        // The service refused this attempt's registered client for another sign-in, so this one
        // reports that refusal, as its own exchange would have, without asking the service again.
        if (
          storedRef?.source === "registered" &&
          holder.client === storedRef.id &&
          holder.withdrawal === "rejected"
        )
          return yield* failed(
            storedRef.fresh ? "registered_client_incompatible" : "registered_client_rejected",
          );
        return yield* failed("client_unavailable");
      }
      const holding = holder?.kind === "held" ? holder.row : undefined;
      if (holding !== undefined && !(yield* clientAuthorized(holding)))
        return yield* failed("client_unavailable");
      const parameters = yield* protocol
        .callback(operating, callback)
        .pipe(Effect.mapError(callbackFailed));
      const tokens = yield* protocol.exchange(operating, parameters).pipe(
        Effect.mapError(exchangeFailed),
        Effect.catchIf(
          (error) => error.reason === "invalid_client" && storedRef?.source === "registered",
          (error) =>
            Effect.gen(function* () {
              const stored = storedRef;
              if (stored === undefined || scope === undefined || isFirstPartyAttempt(attempt))
                return yield* error;
              const version = yield* Effect.fromResult(Base64.decode(stored.version)).pipe(
                Effect.mapError(() => new StorageError()),
              );
              // Only the version this attempt used: a client saved since then stays. Its credentials
              // are withdrawn as the service's refusal, which other sign-ins pending with it report
              // without an exchange, unless a person removed it first.
              // The rejected client's own identity: a client stored before 4.0.12 keeps its
              // provider's until its server is recorded.
              const rejectedRow = named ?? holding;
              const digest =
                rejectedRow === undefined
                  ? yield* digestOf(scope, registrationCredentials(attempt.client))
                  : yield* storedDigestOf(rejectedRow, registrationCredentials(attempt.client));
              const after = yield* transaction(db, (tx) =>
                Effect.gen(function* () {
                  yield* query(() =>
                    tx.deleteMany("storedOAuthClients", {
                      where: (b) => b.and(b("id", "=", stored.id), b("encrypted", "=", version)),
                    }),
                  );
                  yield* withdrawCredentials(tx, stored.id, "rejected");
                  return yield* credentialsOwner(tx, digest);
                }),
              );
              // A person may have removed the client while the code was being exchanged, and a
              // removal is never recorded over. Then the client is unavailable, as for any sign-in
              // pending with it; the service's refusal is reported only when it is what was recorded.
              if (
                after?.kind !== "withdrawn" ||
                after.client !== stored.id ||
                after.withdrawal !== "rejected"
              )
                return yield* failed("client_unavailable");
              return yield* new OAuthCompletionFailed({
                reason: stored.fresh
                  ? "registered_client_incompatible"
                  : "registered_client_rejected",
                ...(error.cause === undefined ? {} : { cause: error.cause }),
                ...(error.serviceError === undefined ? {} : { serviceError: error.serviceError }),
              });
            }),
        ),
      );
      // The operator's client keeps no grant holding a scope it does not allow.
      if (isFirstPartyAttempt(attempt) && !grantAllowed(attempt.firstParty, tokens.scope)) {
        yield* revokeRefused(attempt.firstParty, {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
        });
        return yield* new OAuthCompletionFailed({
          reason: "scope_exceeded",
          cause: { stage: "exchange", field: "scope" },
        });
      }
      const fields = yield* project(attempt.response, tokens).pipe(
        Effect.mapError(
          () =>
            new OAuthCompletionFailed({
              reason: "incompatible_response",
              cause: { stage: "exchange" },
            }),
        ),
      );
      const completedAt = yield* Clock.currentTimeMillis;
      const issued = {
        response: attempt.response,
        fields,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...expiry(completedAt, tokens.expires_in),
      };
      // An entered client the connection asked to keep becomes a stored client of its owner,
      // unless one holds it already.
      const savedClient =
        isFirstPartyAttempt(attempt) ||
        scope === undefined ||
        attempt.saveClient !== true ||
        holding !== undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const client = attempt.client;
              const id = OAuthClientId.make(`oac_${yield* nextId}`);
              const details = registrationCredentials(client);
              return {
                row: {
                  id,
                  owner: attempt.owner,
                  provider: null,
                  issuer: scope.issuer,
                  clientId: client.client_id,
                  source: "manual" as const,
                  hasSecret: client.token_endpoint_auth_method !== "none",
                  automaticKey: null,
                  confirmed: true,
                  createdAt: new Date(completedAt),
                  encrypted: yield* encrypt(id, details),
                },
                digest: yield* digestOf(scope, details),
              };
            });
      const oauthClient = isFirstPartyAttempt(attempt)
        ? undefined
        : (savedClient?.row.id ?? holding?.id ?? attempt.storedClient?.id);
      /** The grant for the account's credential generation it starts. */
      const grantOf = (generation: number) =>
        decode(
          OAuthGrant,
          isFirstPartyAttempt(attempt)
            ? { ...issued, grant: "authorization_code", firstParty: attempt.firstParty, generation }
            : {
                ...issued,
                server: attempt.server,
                client: attempt.client,
                ...(oauthClient === undefined ? {} : { oauthClient }),
                ...(attempt.resource === undefined ? {} : { resource: attempt.resource }),
                ...(attempt.tokenRequestFormat === undefined
                  ? {}
                  : { tokenRequestFormat: attempt.tokenRequestFormat }),
                ...(attempt.tokenResponse === undefined
                  ? {}
                  : { tokenResponse: attempt.tokenResponse }),
                generation,
              },
        ).pipe(Effect.flatMap((grant) => encrypt(attempt.account, grant)));
      const encryptedCredentials = yield* encrypt(attempt.account, fields);
      const ready = `ready_${yield* nextId}`;
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const current = yield* requireOpen(input, yield* lockConnection(tx, input, crypto));
          // A newer sign-in started while the token exchange was running.
          if (current.oauthAttempt !== id) return yield* failed("sign_in_replaced");
          // A person may have removed the stored client while its code was being exchanged. The
          // no-op update locks its row in the order a removal takes it, so a removal either commits
          // first, and the sign-in fails closed as for any pending with the client, or waits for
          // this account, which then counts as connected before the removal like any other.
          const used = named ?? holding;
          if (used !== undefined) {
            yield* query(() =>
              tx.updateMany("storedOAuthClients", {
                where: (b) => b.and(b("id", "=", used.id), b("owner", "=", used.owner)),
                set: { owner: used.owner },
              }),
            );
            const still = yield* query(() =>
              tx.findFirst("storedOAuthClients", { where: (b) => b("id", "=", used.id) }),
            );
            if (still === null) return yield* failed("client_unavailable");
          }
          // Read again after the remote exchange: deletion must win, and a concurrent rename must survive.
          const target = attempt.reconnect ? yield* reconnectTarget(tx, attempt) : undefined;
          const saved =
            target ??
            (yield* decode(Account, {
              id: attempt.account,
              provider: attempt.provider,
              owner: attempt.owner,
              label: attempt.label ?? (yield* defaultLabel(tx, attempt.owner, attempt.provider)),
              description: null,
              method: attempt.method,
              createdAt: new Date(completedAt),
            }));
          // A reconnect may sign in as another upstream identity: start a new generation.
          const generation = target === undefined ? 0 : target.credentialGeneration + 1;
          if (target !== undefined) {
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", target.id),
                set: { encryptedCredentials, credentialGeneration: generation },
              }),
            );
          } else {
            yield* query(() =>
              tx.create("accounts", { ...saved, encryptedCredentials, credentialGeneration: 0 }),
            );
            if (lifecycle) yield* lifecycle.accountCreated(saved);
          }
          const grant = {
            encrypted: yield* grantOf(generation),
            status: ready,
            updatedAt: new Date(completedAt),
          };
          yield* query(() =>
            tx.upsert("oauthGrants", {
              where: (b) => b("id", "=", saved.id),
              create: { id: saved.id, ...grant },
              update: grant,
            }),
          );
          yield* query(() =>
            tx.updateMany("oauthAttempts", {
              where: (b) => b("id", "=", id),
              set: { status: "completed", encrypted: new Uint8Array() },
            }),
          );
          if (lifecycle)
            yield* lifecycle.connectionCompleting({
              id: current.id,
              owner: current.owner,
              reconnectAccount: current.reconnectAccount,
              target: { app: current.target.app, requirement: current.target.requirement },
            });
          yield* finishConnection(tx, current, saved, lifecycle);
          // Credentials a client was registered with during this sign-in are that client's and
          // are not saved again. The grant then names a client that does not exist, which is
          // harmless: its copy of the credentials still resolves to the client holding them.
          if (savedClient !== undefined)
            yield* createStoredClient(tx, savedClient.row, savedClient.digest);
          // A completed sign-in confirms the client: a later rejection means it was revoked.
          const stored = isFirstPartyAttempt(attempt) ? undefined : attempt.storedClient;
          if (stored !== undefined && stored.fresh)
            yield* query(() =>
              tx.updateMany("storedOAuthClients", {
                where: (b) => b("id", "=", stored.id),
                set: { confirmed: true },
              }),
            );
          return saved;
        }),
      );
    });

  /**
   * Resolve the account's current credentials. With `rejected`, the service has refused those
   * credentials: a grant still holding them is renewed now, whatever its recorded lifetime, and a
   * grant another call already renewed returns its newer credentials. A grant that cannot be
   * renewed returns the same credentials, so the caller can tell that nothing changed.
   *
   * A grant that needs reconnecting is an expected account state, not a fault of this operation:
   * it is returned as a value and recorded as the span's outcome, and only failed after the span.
   */
  const resolveCredentials = (
    account: StoredAccount,
    provider: ProviderDefinition,
    resolution: Resolution,
    rejected?: JsonObject,
  ) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("oauth.provider.id", account.provider);
      if (rejected !== undefined)
        yield* Effect.annotateCurrentSpan("oauth.renewal.trigger", "credentials_rejected");
      // Secrets the user brought.
      if (provider.auth[account.method]?.type === "secrets")
        return {
          fields: yield* credentials.decrypt(account.id, account.encryptedCredentials),
          firstParty: undefined,
          generation: account.credentialGeneration,
        } satisfies AccountCredential;
      /** Record why the grant cannot be used on this span; only fixed vocabularies and codes. */
      const reconnect = (reason: ReconnectReason, cause?: OAuthFailureCause) =>
        reconnectRequired("oauth.resolve", account.id, reason, cause);
      // Set once this call has waited for another renewal of the grant. The token it then reads
      // is that renewal's result, and is used until it expires rather than renewed ahead again.
      let awaited = false;
      const readAhead = yield* GrantReadAhead;
      while (true) {
        const ahead =
          readAhead !== undefined && !awaited && !resolution.contested
            ? readAhead.get(account.id)
            : undefined;
        readAhead?.delete(account.id);
        const row: GrantRow | null =
          ahead !== undefined
            ? ahead
            : yield* query(() =>
                db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
              );
        if (row === null) return yield* reconnect("grant_missing");
        if (row.status === "reconnect") return yield* reconnect("grant_unusable");
        const now = yield* Clock.currentTimeMillis;
        // A renewal holds the grant. Its row still carries the grant it started from.
        const claimed = !row.status.startsWith("ready_");
        if (
          claimed &&
          (heldClaims.has(row.status) || now - row.updatedAt.getTime() <= renewalLease)
        ) {
          awaited = true;
          resolution.contested = true;
          readAhead?.clear();
          yield* Effect.sleep("100 millis");
          continue;
        }
        // An unconfirmed claim was abandoned by a process that stopped before saving a result.
        // Renew again from the saved grant, as it would have. See renewalLease.
        const abandoned = claimed;
        const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant);
        const renewable = grant.grant === "client_credentials" || grant.refreshToken !== undefined;
        // The service refused exactly the credentials this grant still holds. A grant another
        // call has renewed since then holds different ones, which this call uses instead.
        const refused = rejected !== undefined && sameFields(grant.fields, rejected);
        /** These values as the credential this grant holds: managed or not, and its generation. */
        const held = (fields: JsonObject): AccountCredential => ({
          fields: Redacted.make(fields),
          firstParty: isFirstPartyGrant(grant) ? grant.firstParty : undefined,
          generation: grant.generation ?? account.credentialGeneration,
        });
        if (refused && !renewable) return held(grant.fields);
        if (
          !abandoned &&
          !refused &&
          (grant.expiresAt === undefined ||
            grant.expiresAt > now + (awaited ? 0 : 30_000) ||
            (!renewable && grant.expiresAt > now))
        )
          return held(grant.fields);
        if (protocol === undefined) return yield* reconnect("not_renewable");
        const stage = grant.grant === "client_credentials" ? "clientCredentials" : "refresh";
        const renewal =
          grant.grant === "client_credentials"
            ? protocol.clientCredentials(grant)
            : yield* refreshOf(protocol, grant);
        if (renewal === undefined) return yield* reconnect("not_renewable");
        const claim = `refresh_${yield* nextId}`;
        /**
         * What this renewal attempt records about its claim, as plain values set while it holds
         * the claim: when it won the claim, and what the service answered if the claim was gone
         * before the result was saved (taken over, replaced by a reconnect, or removed). They are
         * recorded only after the attempt releases the claim, so recording adds nothing to the
         * time the grant is held.
         */
        const recorded: { claimedAt?: Date; lost?: "tokens" | OAuthFailureCause } = {};
        /** Renew under the claim and save the outcome; undefined when the claim was lost. */
        const settle = Effect.gen(function* () {
          const result = yield* renewal.pipe(
            Effect.annotateSpans("oauth.provider.id", account.provider),
            Effect.mapError((error) => {
              const outcome = renewalOutcome(error);
              return {
                outcome,
                cause: causeOf(stage, error),
                retry: retryAfterOf(outcome, error),
                exceeded: undefined,
              };
            }),
            // A renewal of a grant to the operator's client must not report a scope the client
            // does not allow. The grant then needs reconnecting, and the response's tokens are
            // revoked.
            Effect.filterOrFail(
              (tokens) => !isFirstPartyGrant(grant) || grantAllowed(grant.firstParty, tokens.scope),
              (tokens) => ({
                outcome: "reconnect" as const,
                cause: { stage, field: "scope" } satisfies OAuthFailureCause,
                retry: {},
                exceeded: { refreshToken: tokens.refresh_token, accessToken: tokens.access_token },
              }),
            ),
            Effect.flatMap((tokens) =>
              project(grant.response, { ...grant.fields, ...tokens }).pipe(
                // The service issued tokens, but not in the shape the provider declares.
                Effect.mapError(() => ({
                  outcome: "incompatible_response" as const,
                  cause: { stage } satisfies OAuthFailureCause,
                  retry: {},
                  exceeded: undefined,
                })),
                Effect.map((fields) => ({ tokens, fields })),
              ),
            ),
            Effect.result,
          );
          if (result._tag === "Failure") {
            const { outcome, cause, retry, exceeded } = result.failure;
            yield* Effect.annotateCurrentSpan("oauth.renewal.outcome", outcome);
            const released = `ready_${yield* nextId}`;
            // Only the process holding the claim may settle it. Otherwise another process has
            // already settled this revision, and the loop reads its result.
            const settled = yield* transaction(db, (tx) =>
              Effect.gen(function* () {
                const current = yield* query(() =>
                  tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
                );
                if (current?.status !== claim) return false;
                yield* query(() =>
                  tx.updateMany("oauthGrants", {
                    where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                    // Anything but a refusal releases the claim with the grant and its refresh
                    // token unchanged, so a later call can renew it.
                    set:
                      outcome === "reconnect"
                        ? { status: "reconnect" }
                        : { status: released, updatedAt: row.updatedAt },
                  }),
                );
                return true;
              }),
            );
            if (exceeded !== undefined && isFirstPartyGrant(grant)) {
              // The refused response's tokens are revoked whether or not this claim still held
              // the grant. When it did, the grant has ended too, so its refresh token is revoked
              // if the response rotated none. A grant that replaced it meanwhile, such as by a
              // reconnect, is never touched.
              yield* revokeRefused(
                grant.firstParty,
                settled
                  ? { ...exceeded, refreshToken: exceeded.refreshToken ?? grant.refreshToken }
                  : exceeded,
              );
              if (settled) return yield* reconnect("scope_exceeded", cause);
            }
            if (!settled) {
              recorded.lost = exceeded === undefined ? cause : "tokens";
              return undefined;
            }
            if (outcome === "reconnect")
              return yield* reconnect(abandoned ? "renewal_interrupted" : "renewal_refused", cause);
            // The grant is kept, and a renewal ahead of expiry leaves its token valid. Callers
            // that waited for this renewal use that token, and so does this one. The next use
            // inside the renewal window tries again. A token the service refused, or one that has
            // expired, cannot be used, so the failure stands.
            if (
              !refused &&
              (grant.expiresAt === undefined || grant.expiresAt > (yield* Clock.currentTimeMillis))
            ) {
              yield* Effect.annotateCurrentSpan({
                "oauth.resolve.outcome": "current_token",
                ...causeAttributes(cause),
              });
              yield* Effect.logWarning("OAuth renewal failed; using the current token").pipe(
                Effect.annotateLogs({
                  "oauth.provider.id": account.provider,
                  "oauth.renewal.outcome": outcome,
                }),
              );
              return held(grant.fields);
            }
            return yield* new OAuthRenewalFailed({
              account: account.id,
              reason: outcome,
              cause,
              ...retry,
            });
          }
          const { fields, tokens } = result.success;
          const updatedAt = new Date(yield* Clock.currentTimeMillis);
          /**
           * The grant with this renewal's tokens. The renewed token's lifetime replaces the
           * previous one, including when it states none.
           */
          const refreshToken =
            grant.grant === "client_credentials"
              ? undefined
              : (tokens.refresh_token ?? grant.refreshToken);
          const renewedFrom = (base: OAuthGrant) =>
            decode(OAuthGrant, {
              ...Struct.omit(base, ["expiresAt"]),
              fields,
              ...(base.grant === "client_credentials" || refreshToken === undefined
                ? {}
                : { refreshToken }),
              ...expiry(updatedAt.getTime(), tokens.expires_in),
            }).pipe(Effect.flatMap((updated) => encrypt(account.id, updated)));
          const renewed = yield* renewedFrom(grant);
          const encryptedCredentials = yield* encrypt(account.id, fields);
          const ready = `ready_${yield* nextId}`;
          const committed = yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              const saved = yield* query(() =>
                tx.findFirst("accounts", { where: (b) => b("id", "=", account.id) }),
              );
              if (saved === null) return false;
              // Only the tokens are this renewal's. The grant is written on the condition that it
              // still holds what was read, and read again otherwise, so a write that kept the
              // claim is carried forward rather than replaced by the grant this renewal started
              // from, however the two interleave.
              while (true) {
                const current = yield* query(() =>
                  tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
                );
                if (current?.status !== claim) return false;
                const encrypted =
                  Base64.encode(current.encrypted) === Base64.encode(row.encrypted)
                    ? renewed
                    : yield* decrypt(account.id, current.encrypted, OAuthGrant).pipe(
                        Effect.flatMap(renewedFrom),
                      );
                yield* query(() =>
                  tx.updateMany("oauthGrants", {
                    where: (b) =>
                      b.and(
                        b("id", "=", account.id),
                        b("status", "=", claim),
                        b("encrypted", "=", current.encrypted),
                      ),
                    set: { status: ready, encrypted, updatedAt },
                  }),
                );
                const written = yield* query(() =>
                  tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
                );
                if (written?.status === ready) break;
              }
              yield* query(() =>
                tx.updateMany("accounts", {
                  where: (b) => b("id", "=", account.id),
                  set: { encryptedCredentials },
                }),
              );
              return true;
            }),
          );
          if (!committed) {
            recorded.lost = "tokens";
            return undefined;
          }
          yield* Effect.annotateCurrentSpan("oauth.renewal.outcome", "renewed");
          return held(fields);
        });
        // From claiming the grant to settling it, the renewal cannot be interrupted: a caller that
        // times out or disconnects would otherwise abandon a live claim, and with it any rotated
        // refresh token the service has already issued. The token request is bounded by its own
        // timeout, so an interruption waits at most that long plus the save.
        resolution.contested = true;
        readAhead?.clear();
        const renewed = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const claimedAt = new Date(yield* Clock.currentTimeMillis);
            yield* query(() =>
              db.updateMany("oauthGrants", {
                where: (b) => b.and(b("id", "=", account.id), b("status", "=", row.status)),
                set: { status: claim, updatedAt: claimedAt },
              }),
            );
            const current = yield* query(() =>
              db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            if (current?.status !== claim) return undefined;
            heldClaims.add(claim);
            recorded.claimedAt = claimedAt;
            // How long a claim this renewal took over went unconfirmed tells a process that died
            // from one whose confirmations stopped while it kept running. Only the caller that won
            // the claim records it.
            if (abandoned)
              yield* Effect.annotateCurrentSpan(
                "oauth.renewal.abandoned_claim_age_ms",
                now - row.updatedAt.getTime(),
              );
            // Confirmations made and failed while this renewal held the claim, recorded on its span.
            const beats = { confirmed: 0, failed: 0 };
            const heartbeat = yield* Effect.forkChild(
              Effect.sleep(renewalHeartbeat).pipe(
                Effect.andThen(Clock.currentTimeMillis),
                Effect.flatMap((confirmedAt) =>
                  query(() =>
                    db.updateMany("oauthGrants", {
                      where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                      set: { updatedAt: new Date(confirmedAt) },
                    }),
                  ),
                ),
                Effect.tap(() =>
                  Effect.sync(() => {
                    beats.confirmed++;
                  }),
                ),
                // A failed confirmation is retried at the next beat; the lease spans several.
                Effect.catch(() =>
                  Effect.sync(() => {
                    beats.failed++;
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning("OAuth renewal could not confirm its claim").pipe(
                        Effect.annotateLogs("oauth.provider.id", account.provider),
                      ),
                    ),
                  ),
                ),
                Effect.forever,
                Effect.interruptible,
              ),
            );
            return yield* settle.pipe(
              Effect.ensuring(
                Fiber.interrupt(heartbeat).pipe(
                  Effect.andThen(Effect.sync(() => heldClaims.delete(claim))),
                  Effect.andThen(
                    Effect.suspend(() =>
                      Effect.annotateCurrentSpan({
                        "oauth.renewal.heartbeats": beats.confirmed,
                        "oauth.renewal.heartbeat_failures": beats.failed,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        ).pipe(
          // Each attempt that won the claim has its own span, emitted after it released the claim,
          // so a resolve that loses its claim and renews again records each attempt separately.
          // It names the grant the attempt held and when it took it, and whether it took over
          // another holder's claim, so a later reconnect of the same grant can be matched to the
          // takeover. Recording never changes the result: any failure, defects included, is
          // discarded.
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const { claimedAt, lost } = recorded;
              if (claimedAt === undefined) return;
              const releasedAt = yield* Clock.currentTimeMillis;
              const unconfirmed = now - row.updatedAt.getTime();
              // A reconnect this attempt decided is its result. The failure states every reason a
              // renewal can reach except `renewal_refused`.
              const reconnected =
                Exit.isSuccess(exit) && Schema.is(OAuthReconnectRequired)(exit.value)
                  ? exit.value
                  : undefined;
              // Whether the service rotated a refresh token that this attempt then discarded:
              // tokens, `invalid_grant`, or any other failure.
              const lostResult =
                lost === undefined
                  ? undefined
                  : lost === "tokens"
                    ? lost
                    : lost.providerError === "invalid_grant"
                      ? "invalid_grant"
                      : "error";
              yield* (
                lostResult === undefined
                  ? Effect.void
                  : Effect.logWarning("OAuth renewal lost its claim before saving the result").pipe(
                      Effect.annotateLogs({
                        "oauth.provider.id": account.provider,
                        "oauth.renewal.lost_claim_result": lostResult,
                      }),
                    )
              ).pipe(
                Effect.withSpan("oauth.renewal", {
                  attributes: {
                    "oauth.provider.id": account.provider,
                    "executor.account.id": account.id,
                    // A grant from a sign-in stores its generation. A client-credentials grant, or
                    // one saved before grants stored it, uses the account's, read with the account,
                    // which a concurrent reconnect can leave stale.
                    "executor.account.credential_generation":
                      grant.generation ?? account.credentialGeneration,
                    "executor.account.credential_generation_source":
                      grant.generation === undefined ? "account" : "grant",
                    "oauth.renewal.claimed_at_ms": claimedAt.getTime(),
                    "oauth.renewal.takeover": abandoned,
                    ...(abandoned
                      ? {
                          "oauth.renewal.abandoned_claim_age_ms": unconfirmed,
                          "oauth.renewal.takeover_expired_ms": unconfirmed - renewalLease,
                        }
                      : {}),
                    ...(lostResult === undefined
                      ? {}
                      : { "oauth.renewal.lost_claim_result": lostResult }),
                    ...(reconnected === undefined
                      ? {}
                      : {
                          "oauth.reconnect.reason": reconnected.reason ?? "renewal_refused",
                          "oauth.reconnect.at_ms": releasedAt,
                          ...(reconnected.cause === undefined
                            ? {}
                            : causeAttributes(reconnected.cause)),
                        }),
                  },
                }),
              );
            }).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );
        if (renewed === undefined) {
          // Another resolve claimed or settled this revision first; read its result.
          awaited = true;
          continue;
        }
        return renewed;
      }
    }).pipe(
      Effect.withSpan("oauth.resolve"),
      Effect.flatMap((resolved) =>
        Schema.is(OAuthReconnectRequired)(resolved)
          ? Effect.fail(resolved)
          : Effect.succeed(resolved),
      ),
    );

  /**
   * Fail as `resolve` would when the stored grant can no longer release credentials, without
   * renewing it or releasing anything. A grant that renewal would replace still passes; its
   * outcome is known only once a live resolve renews it. A grant that needs reconnecting is
   * recorded as the span's outcome, as `resolve` records it, and fails only after the span.
   */
  const usable = (account: StoredAccount, provider: ProviderDefinition) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("oauth.provider.id", account.provider);
      if (provider.auth[account.method]?.type === "secrets") return;
      const reconnect = (reason: ReconnectReason) =>
        reconnectRequired("oauth.usable", account.id, reason);
      const row = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
      );
      if (row === null) return yield* reconnect("grant_missing");
      if (row.status === "reconnect") return yield* reconnect("grant_unusable");
      // A renewal in progress, or one a stopped process abandoned, is settled by the next live
      // resolve; its outcome is not known until then.
      if (!row.status.startsWith("ready_")) return;
      const now = yield* Clock.currentTimeMillis;
      const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant);
      const renewable = grant.grant === "client_credentials" || grant.refreshToken !== undefined;
      if (
        grant.expiresAt === undefined ||
        grant.expiresAt > now + 30_000 ||
        (!renewable && grant.expiresAt > now)
      )
        return;
      if (protocol === undefined || !renewable) return yield* reconnect("not_renewable");
    }).pipe(
      Effect.withSpan("oauth.usable"),
      Effect.flatMap((checked) =>
        Schema.is(OAuthReconnectRequired)(checked) ? Effect.fail(checked) : Effect.void,
      ),
    );

  /** The accounts the product still authorizes; undefined when it has no lifecycle. */
  const authorized = (accounts: readonly StoredAccount[]) =>
    lifecycle === undefined || !Arr.isReadonlyArrayNonEmpty(accounts)
      ? Effect.succeed(undefined)
      : lifecycle.accountsResolving(accounts);
  /** Fail unless the product still authorizes every one of `accounts` in `current`. */
  const enforced = (
    current: Effect.Effect<ReadonlySet<AccountId> | undefined, StorageError>,
    accounts: readonly StoredAccount[],
  ) =>
    Effect.flatMap(current, (allowed) =>
      allowed === undefined || accounts.every((account) => allowed.has(account.id))
        ? Effect.void
        : Effect.fail(new AccountUseRefused()),
    );
  /**
   * Resolve one account checked in `allowed`, and run `recheck` if resolving waited or renewed.
   * `resolution` records whether it did.
   */
  const resolveAuthorized = (
    account: StoredAccount,
    provider: ProviderDefinition,
    allowed: ReadonlySet<AccountId> | undefined,
    resolution: Resolution,
    rejected?: JsonObject,
    recheck: Effect.Effect<void, StorageError | AccountUseRefused> = enforced(
      authorized([account]),
      [account],
    ),
  ) =>
    Effect.gen(function* () {
      if (allowed !== undefined && !allowed.has(account.id)) return yield* new AccountUseRefused();
      const fields = yield* resolveCredentials(account, provider, resolution, rejected);
      // A remote token refresh can outlive a permission change, an unlinking or account deletion.
      if (resolution.contested) yield* recheck;
      return fields;
    });
  const resolve = (account: StoredAccount, provider: ProviderDefinition, rejected?: JsonObject) =>
    Effect.flatMap(authorized([account]), (allowed) =>
      resolveAuthorized(account, provider, allowed, { contested: false }, rejected),
    ).pipe(
      // A refusal is the storage failure callers that do not distinguish it have always seen.
      Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())),
    );
  /**
   * Running the app's code needs the current actor to use the app; removing what the app
   * registered, or checking an account, does not. To run it, the actor's app access, its use of
   * the user accounts and the app link of each app requirement's account (`appUses`) are
   * rechecked in one product read. Removing what the app registered rechecks the actor's use of
   * the user accounts and the app's authority over the app accounts it registered with, linked
   * or not since. Checking an account rechecks only the actor's use of it. An account used by both
   * scopes is in both lists and passes only when every check does.
   */
  const authorizedFor = (
    use: CredentialUse,
    accounts: readonly StoredAccount[],
    appUses: ReadonlyArray<AppAccountUse> = [],
  ): Effect.Effect<ReadonlySet<AccountId> | undefined, StorageError> =>
    lifecycle === undefined
      ? Effect.succeed(undefined)
      : use.kind === "run"
        ? lifecycle.appResolving(use.app, accounts, appUses)
        : use.kind === "removal"
          ? accounts.length === 0 && appUses.length === 0
            ? Effect.succeed(undefined)
            : lifecycle.removalResolving(use.app, accounts, appUses)
          : authorized(accounts);
  /**
   * Product authority over a whole selection, for every use the evaluation makes of each account:
   * the actor's use where a user requirement uses it, and the app's authority for each app
   * requirement it fills. Running the app also rechecks the actor's app access in the same read.
   */
  const selectionAuthority = (
    use: CredentialUse,
    selection: ReadonlyArray<{ readonly account: StoredAccount } & AccountUses>,
  ) =>
    authorizedFor(
      use,
      selection.filter(({ user }) => user).map(({ account }) => account),
      selection.flatMap(({ account, appUses }) =>
        appUses.map((requirement) => ({ requirement, account })),
      ),
    );
  /**
   * Fail unless the product still authorizes the whole selection; see `selectionAuthority`.
   * Run after any renewal wait, since every account's earlier check can then be seconds old.
   */
  const selectionAuthorized = (
    use: CredentialUse,
    selection: ReadonlyArray<{ readonly account: StoredAccount } & AccountUses>,
  ) =>
    enforced(
      selectionAuthority(use, selection),
      selection.map(({ account }) => account),
    );
  /**
   * Resolve each selected account's credentials in order, for evaluating the app's code. To run
   * the app, the product first rechecks that the current actor may use it, even without accounts;
   * removing what the app registered needs no app access. Product authority for all accounts is
   * always checked in the same read, and refused in selection order. Once any account has waited
   * for or performed a renewal, that read can be seconds old, so the whole selection, including
   * the accounts already resolved and app access, is checked again before anything else resolves
   * or the credentials are returned. A refusal fails with `AccountUseRefused`. A caller that ran
   * the first check beside its own reads supplies its outcome as `authority`.
   */
  const resolveSelected = (
    use: Exclude<CredentialUse, { readonly kind: "check" }>,
    selected: ReadonlyArray<
      {
        readonly account: StoredAccount;
        readonly provider: ProviderDefinition;
      } & AccountUses
    >,
    authority: Effect.Effect<ReadonlySet<AccountId> | undefined, StorageError> = selectionAuthority(
      use,
      selected,
    ),
  ) =>
    Effect.flatMap(authority, (checked) => {
      const recheck = selectionAuthorized(use, selected);
      return Effect.forEach(selected, ({ account, provider }) =>
        Effect.gen(function* () {
          const credential = yield* resolveAuthorized(
            account,
            provider,
            checked,
            { contested: false },
            undefined,
            recheck,
          );
          /** The account as one slot's invocation sends it, under that slot's definition. */
          return (definition: ProviderDefinition) =>
            invocationAccount(account, definition, credential, firstPartyClients);
        }),
      );
    });
  /**
   * The service refused these credentials. Renew the grant once, or read a renewal another call
   * already made, and return the account's current credentials. They equal `rejected` when the
   * account cannot be renewed, such as a secrets account or a grant without a refresh token. A
   * renewal can take seconds, and a call that runs the app again sends every account of its
   * `selection` with the new credentials, so once a renewal settles the whole selection is
   * checked again for every use the call makes of each account, with app access to run it.
   */
  const renewRejected = (
    use: Exclude<CredentialUse, { readonly kind: "removal" }>,
    account: StoredAccount,
    provider: ProviderDefinition,
    rejected: JsonObject,
    selection: ReadonlyArray<{ readonly account: StoredAccount } & AccountUses> = [
      { account, user: true, appUses: [] },
    ],
  ) => {
    const recheck = selectionAuthorized(use, selection);
    return Effect.flatMap(recheck, () =>
      resolveAuthorized(account, provider, undefined, { contested: false }, rejected, recheck),
    ).pipe(
      // A refusal is the storage failure callers that do not distinguish it have always seen.
      Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())),
    );
  };
  /**
   * RFC 7009 revocation with the grant's own client, at its server's revocation endpoint. The
   * refresh token is revoked when present, since that also ends its access tokens at most
   * services; otherwise the access token. The token type is recorded on the span; values never are.
   */
  const revokeTokens = (
    grant: { readonly server: OAuthTokenServer; readonly client: OAuthRegistration },
    tokens: { readonly refreshToken: string | undefined; readonly accessToken: unknown },
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined || grant.server.revocation_endpoint === undefined)
        return "unsupported" as const;
      const { refreshToken, accessToken } = tokens;
      const token =
        refreshToken !== undefined
          ? { token: refreshToken, tokenTypeHint: "refresh_token" as const }
          : typeof accessToken === "string" && accessToken !== ""
            ? { token: accessToken, tokenTypeHint: "access_token" as const }
            : undefined;
      if (token === undefined) return "no_token" as const;
      yield* Effect.annotateCurrentSpan("oauth.revocation.token_type_hint", token.tokenTypeHint);
      yield* protocol.revoke({ server: grant.server, client: grant.client, ...token });
      return "revoked" as const;
    });
  /** Record a best-effort revocation's outcome on its span; nothing here can fail. */
  const settledRevocation = <R>(
    revocation: Effect.Effect<string, unknown, R>,
    span: "oauth.revokeGrant" | "oauth.revokeRefused",
  ) =>
    revocation.pipe(
      Effect.catch(() => Effect.succeed("failed")),
      Effect.catchDefect(() => Effect.succeed("failed")),
      Effect.tap((outcome) => Effect.annotateCurrentSpan("oauth.revocation.outcome", outcome)),
      Effect.asVoid,
      Effect.withSpan(span),
    );
  /**
   * Revoke beside the response when the host accepts background work (the same hand-off stale
   * declarations use); otherwise inline, bounded by the protocol's request timeout.
   */
  const revokeLater = (revocation: Effect.Effect<void>) =>
    background === undefined
      ? revocation
      : background(revocation).pipe(
          Effect.flatMap((accepted) => (accepted ? Effect.void : revocation)),
        );

  /**
   * Best-effort revocation of a grant whose account was already deleted. Nothing here can fail or
   * undo the deletion.
   */
  const revokeGrant = (removed: {
    readonly account: AccountId;
    readonly provider: string;
    readonly encrypted: Uint8Array;
  }) =>
    settledRevocation(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("oauth.provider.id", removed.provider);
        const stored = yield* decrypt(removed.account, removed.encrypted, OAuthGrant);
        // A grant to the operator's client is revoked at the client's configured endpoint.
        const grant = yield* operatingGrant(stored);
        if (grant === undefined) return "unsupported" as const;
        return yield* revokeTokens(grant, {
          refreshToken: grant.grant === "client_credentials" ? undefined : grant.refreshToken,
          accessToken: grant.fields["access_token"],
        });
      }),
      "oauth.revokeGrant",
    );
  /** Revoke after the deletion commits; see `revokeLater`. */
  const revokeRemoved = (removed: Parameters<typeof revokeGrant>[0]) =>
    revokeLater(revokeGrant(removed));
  /**
   * Revoke tokens the operator's client `id` was issued with a scope it does not allow, which
   * Executor refused to keep, at the operator's revocation endpoint.
   */
  const revokeRefused = (
    id: FirstPartyOAuthClientId,
    tokens: { readonly refreshToken: string | undefined; readonly accessToken: unknown },
  ) =>
    revokeLater(
      settledRevocation(
        operatorClient(id).pipe(
          Effect.flatMap((operator) =>
            operator === undefined
              ? Effect.succeed("unsupported" as const)
              : revokeTokens(operator, tokens),
          ),
        ),
        "oauth.revokeRefused",
      ),
    );

  /** Whether deleting the account would revoke its grant, by the rule `revokeGrant` follows. */
  const revocation = (account: AccountId) =>
    Effect.gen(function* () {
      if (protocol === undefined) return { revocation: "manual" as const };
      const row = yield* query(() =>
        db.findFirst("oauthGrants", { where: (b) => b("id", "=", account) }),
      );
      if (row === null) return { revocation: "manual" as const };
      const grant = yield* operatingGrant(yield* decrypt(account, row.encrypted, OAuthGrant));
      if (grant === undefined) return { revocation: "manual" as const };
      const accessToken = grant.fields["access_token"];
      const token =
        (grant.grant !== "client_credentials" && grant.refreshToken !== undefined) ||
        (typeof accessToken === "string" && accessToken !== "");
      return {
        revocation:
          grant.server.revocation_endpoint !== undefined && token
            ? ("automatic" as const)
            : ("manual" as const),
      };
    }).pipe(Effect.withSpan("oauth.revocation"));

  /**
   * The operator's client an imported grant was issued to, checked as a sign-in with it would be:
   * it is offered here, the provider's method signs in with it (an unlisted client counts, as for
   * a reconnect of its own account), the scopes renewals ask for are ones it allows, and its
   * tokens reach every host the account's app declares. A host they never reach would refuse the
   * app's calls there, so an account imported for it would only seem to work.
   */
  const importedFirstParty = (
    id: FirstPartyOAuthClientId,
    scopes: readonly string[],
    hosts: readonly string[],
    discovered: Parameters<typeof firstPartyClient>[0],
  ) =>
    Effect.gen(function* () {
      const client = firstPartyClients.get(id);
      if (client === undefined)
        return yield* new OAuthGrantNotImportable({ reason: "unavailable" });
      if (firstPartyClient(discovered, id)?.client.id !== id)
        return yield* new OAuthGrantNotImportable({ reason: "method" });
      const allowed = allowedScopes(client);
      if (!scopes.every((scope) => allowed.includes(scope)))
        return yield* new OAuthGrantNotImportable({ reason: "scopes" });
      // A host is reached when a placement host allows every host it does, as a narrower pattern.
      const unreachable = hosts.filter(
        (host) =>
          !intersectCredentialHosts([host], client.placement.hosts).includes(host.toLowerCase()),
      );
      if (hosts.length === 0 || unreachable.length > 0)
        return yield* new OAuthGrantNotImportable({ reason: "hosts", unreachable });
      return client;
    });

  /**
   * Save an account whose grant another product issued (`OAuthGrantImport`). A grant to a client
   * the product registered keeps that client and renews as that product did
   * (`ImportOAuthGrant.renewal`), whatever the provider's method declares; an authorization-code
   * client also becomes a stored client of the owner, as an entered client a sign-in keeps does,
   * so a reconnect can name it. A grant to one of the operator's clients is saved as a sign-in
   * with it saves one: it keeps only the client's ID, and no client is stored for the owner.
   */
  const importGrant = (input: ImportOAuthGrant) =>
    Effect.gen(function* () {
      const { method, discovered, issuer } = yield* resolveSetup({
        provider: input.provider,
        method: input.method,
        redirectUri: input.redirectUri,
      });
      const { renewal } = input;
      const firstParty =
        "firstParty" in input
          ? yield* importedFirstParty(input.firstParty, renewal.scopes, input.hosts, discovered)
          : undefined;
      const fields = yield* project(method.response, {
        access_token: Redacted.value(input.accessToken),
        token_type: "Bearer",
      }).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "unsupported" })));
      const expires = input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt };
      const refresh =
        input.refreshToken === undefined
          ? {}
          : { refreshToken: Redacted.value(input.refreshToken) };
      const scopes = renewal.scopes.length === 0 ? {} : { scopes: renewal.scopes };
      const createdAt = yield* Clock.currentTimeMillis;
      const account = yield* decode(Account, {
        id: AccountId.make(`acc_${yield* nextId}`),
        provider: input.provider,
        owner: input.owner,
        label: input.label,
        description: null,
        method: input.method,
        createdAt: new Date(createdAt),
      });
      const registered =
        "client" in input
          ? yield* Effect.gen(function* () {
              const client = Redacted.value(input.client);
              // Renewals send the issuing product's token endpoint, held to the same policy as a
              // declared one.
              const tokenEndpoint =
                options === undefined
                  ? undefined
                  : parseEndpoint(input.renewal.tokenEndpoint, options.urlPolicy);
              if (tokenEndpoint === undefined)
                return yield* new OAuthSetupFailed({ reason: "discovery_blocked" });
              const server = { ...discovered.server, token_endpoint: tokenEndpoint.href };
              const resource =
                input.renewal.resource === undefined ? {} : { resource: input.renewal.resource };
              const stored =
                discovered.grant === "client_credentials"
                  ? undefined
                  : yield* Effect.gen(function* () {
                      const id = OAuthClientId.make(`oac_${yield* nextId}`);
                      const details = registrationCredentials(client);
                      return {
                        row: {
                          id,
                          owner: input.owner,
                          provider: null,
                          issuer,
                          clientId: client.client_id,
                          source: "manual" as const,
                          hasSecret: client.token_endpoint_auth_method !== "none",
                          automaticKey: null,
                          confirmed: true,
                          createdAt: new Date(createdAt),
                          encrypted: yield* encrypt(id, details),
                        },
                        digest: yield* digestOf({ owner: input.owner, issuer }, details),
                      };
                    });
              const grantOf = (oauthClient: OAuthClientId | undefined) =>
                discovered.grant === "client_credentials"
                  ? {
                      ...Struct.omit(discovered, ["resource"]),
                      server,
                      scopes: input.renewal.scopes,
                      ...resource,
                      client,
                      fields,
                      response: method.response,
                      generation: 0,
                      ...expires,
                    }
                  : {
                      server,
                      client,
                      ...(oauthClient === undefined ? {} : { oauthClient }),
                      response: method.response,
                      ...scopes,
                      ...resource,
                      ...(discovered.tokenRequestFormat === undefined
                        ? {}
                        : { tokenRequestFormat: discovered.tokenRequestFormat }),
                      ...(discovered.tokenResponse === undefined
                        ? {}
                        : { tokenResponse: discovered.tokenResponse }),
                      fields,
                      ...refresh,
                      generation: 0,
                      ...expires,
                    };
              return { stored, grantOf };
            })
          : undefined;
      const encryptGrant = (grant: unknown) =>
        decode(OAuthGrant, grant).pipe(
          Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })),
          Effect.flatMap((decoded) => encrypt(account.id, decoded)),
        );
      const encryptedCredentials = yield* encrypt(account.id, fields);
      const ready = `ready_${yield* nextId}`;
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          // Credentials another stored client holds are that client; nothing is stored twice.
          const saved =
            registered?.stored === undefined
              ? undefined
              : yield* createStoredClient(tx, registered.stored.row, registered.stored.digest);
          const oauthClient =
            saved === undefined ? undefined : saved.stored ? saved.client.id : saved.holder;
          yield* query(() =>
            tx.create("accounts", { ...account, encryptedCredentials, credentialGeneration: 0 }),
          );
          if (lifecycle) yield* lifecycle.accountCreated(account);
          const state = {
            encrypted: yield* encryptGrant(
              registered === undefined
                ? {
                    grant: "authorization_code",
                    firstParty: firstParty?.id,
                    response: method.response,
                    fields,
                    ...refresh,
                    ...scopes,
                    generation: 0,
                    ...expires,
                  }
                : registered.grantOf(oauthClient),
            ),
            status: ready,
            updatedAt: new Date(createdAt),
          };
          yield* query(() =>
            tx.upsert("oauthGrants", {
              where: (b) => b("id", "=", account.id),
              create: { id: account.id, ...state },
              update: state,
            }),
          );
        }),
      );
      return account;
    }).pipe(Effect.withSpan("oauth.importGrant"));

  return {
    revocation,
    clients,
    connections: { oauthSetup, startOAuth, completeOAuth },
    importGrant,
    /** The operator's client `id` as the importer checks a grant against it, without credentials. */
    firstPartyClient: (id: string) => {
      const client = [...firstPartyClients.values()].find((candidate) => candidate.id === id);
      return client === undefined ? undefined : Struct.omit(client, ["clientId", "clientSecret"]);
    },
    findOAuth,
    resolve: (account: StoredAccount, provider: ProviderDefinition) => resolve(account, provider),
    resolveSelected,
    renewRejected,
    usable,
    revokeRemoved,
  };
};
