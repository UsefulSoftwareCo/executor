import { CurrentActor, type AppAccountUse, type ResourceLifecycle } from "../contracts/executor.ts";
import type { BackgroundWork } from "../contracts/declarations.ts";
import { parseDestination, parseEndpoint, httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import {
  Array as Arr,
  Clock,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  JsonSchema,
  Match,
  Option,
  Redacted,
  Schema,
  SchemaRepresentation,
  Struct,
} from "effect";
import type { HostCrypto } from "./host-crypto.ts";
import { Digest } from "effect/crypto";
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
  OAuthResourceIndicator,
  type OAuthResourceSource,
  OAuthAttempt,
  OAuthAttemptId,
  OAuthAttemptRecord,
  OAuthFirstPartyAttempt,
  OAuthServer,
  allowedScopes,
  grantableScopes,
  type OperatorScopeRefusal,
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
  type OAuthOwnClientUnavailable,
  connectionClientsPerServer,
  type OAuthFailureCause,
  type OAuthOptions,
  type OAuthTokenServer,
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
import { inOrder, query, transaction, type Query } from "./database.ts";
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
  clientSpanAttributes,
  isOAuthErrorResponse,
  makeOAuthProtocol,
  preferredClientMethod,
  registrationGrantTypes,
  type OAuthClientKind,
  type OAuthProtocolFailed,
} from "./oauth-protocol.ts";
import { defaultLabel, lockedAccount, ownedAccount, resumeWaitingSources } from "./accounts.ts";
import type { OAuthCallbackField, OAuthFailureDetail } from "./oauth-diagnostics.ts";

export const StoredClientSecret = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.NonEmptyString),
  token_endpoint_auth_method: Schema.optional(OAuthClientAuth),
  client_secret_expires_at: Schema.optional(Schema.Number),
});
export type StoredClientSecret = typeof StoredClientSecret.Type;

interface StoredClientRow {
  readonly id: OAuthClientId;
  readonly owner: OwnerId;
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

interface ClientScope {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly issuer: string;
}

interface SignInScope {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly method: string;
}

const inScope = (row: Pick<StoredClientRow, "owner" | "issuer" | "provider">, scope: ClientScope) =>
  row.owner === scope.owner &&
  (row.issuer === null ? row.provider === scope.provider : row.issuer === scope.issuer);

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

export const storedRegistration = (secret: StoredClientSecret) =>
  secret.token_endpoint_auth_method === undefined
    ? Effect.succeed(undefined)
    : decode(OAuthRegistration, secret);

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

const causeOf = (
  stage: OAuthFailureCause["stage"],
  error: OAuthProtocolFailed,
): OAuthFailureCause => ({
  stage,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.providerError === undefined ? {} : { providerError: error.providerError }),
  ...(error.field === undefined ? {} : { field: error.field }),
});

const serviceErrorOf = (error: OAuthProtocolFailed) =>
  error.serviceError === undefined ? {} : { serviceError: error.serviceError };

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

const sameFields = Schema.toEquivalence(JsonObject);

const renewalHeartbeat = 5_000;
const renewalLease = 20_000;

const heldClaims = new Set<string>();

export interface GrantRow {
  readonly id: string;
  readonly encrypted: Uint8Array;
  readonly status: string;
  readonly updatedAt: Date;
}
export const GrantReadAhead = Context.Reference<Map<AccountId, GrantRow | null> | undefined>(
  "executor/GrantReadAhead",
  { defaultValue: () => undefined },
);

type ReconnectReason =
  | "grant_missing"
  | "grant_unusable"
  | "renewal_interrupted"
  | "not_renewable"
  | "renewal_refused"
  | "scope_exceeded";

const causeAttributes = (cause: OAuthFailureCause) => ({
  "oauth.error.stage": cause.stage,
  ...(cause.status === undefined ? {} : { "http.response.status_code": cause.status }),
  ...(cause.providerError === undefined
    ? {}
    : { "oauth.error.provider_code": cause.providerError }),
  ...(cause.field === undefined ? {} : { "oauth.error.field": cause.field }),
});

export class AccountUseRefused extends Schema.TaggedError<AccountUseRefused>()(
  "AccountUseRefused",
  {},
) {}

interface Resolution {
  contested: boolean;
}
type CredentialUse =
  | { readonly kind: "run"; readonly app: { readonly id: AppId; readonly owner: OwnerId } }
  | { readonly kind: "removal"; readonly app: { readonly id: AppId; readonly owner: OwnerId } }
  | { readonly kind: "check" };
type CredentialPurpose = CredentialUse["kind"] | "resolve";
interface Rejection {
  readonly fields: JsonObject;
  readonly app?: { readonly id: AppId; readonly owner: OwnerId } | undefined;
}
const credentialAccess = (
  purpose: CredentialPurpose,
  account: StoredAccount,
  provider: ProviderDefinition,
  actor: string | undefined,
) => ({
  "oauth.provider.id": account.provider,
  "oauth.resolve.purpose": purpose,
  "oauth.resolve.credential_type": provider.auth[account.method]?.type ?? "unknown",
  "executor.account.id": account.id,
  ...(account.owner.startsWith("organization:")
    ? { "executor.organization.id": account.owner.slice("organization:".length) }
    : {}),
  ...(actor === undefined ? {} : { "executor.user.id": actor }),
});
export interface AccountUses {
  readonly user: boolean;
  readonly appUses: readonly string[];
}

type ReconnectSpan = "oauth.resolve" | "oauth.usable";

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
 * Classify a failed renewal. Only RFC 6749 §5.2's `invalid_grant`, or a service's own code for
 * it such as Supabase Auth's `refresh_token_already_used`, GitHub's `bad_refresh_token`,
 * Slack's `invalid_refresh_token` or AWS Sign-In's `TOKEN_EXPIRED`, says this account's grant
 * has ended, whatever the HTTP status:
 * its refresh token was revoked, expired or already used. Every other refusal keeps the grant,
 * because it says nothing about it:
 *
 * - `invalid_client`, `unauthorized_client` and any other 401 are about the OAuth client, which every
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

const sentResource = (
  value: typeof HttpUrl.Type | undefined,
  source: OAuthResourceSource | undefined,
): OAuthResourceIndicator | undefined => {
  if (source === undefined) return undefined;
  const indicator = { value: value ?? null, source };
  return Schema.is(OAuthResourceIndicator)(indicator) ? indicator : undefined;
};

/**
 * RFC 8707 §2: the service refused the resource indicator the sign-in sent, or its absence. Only
 * a refusal is: a 429 or an outage answered with `invalid_target` keeps its own classification and
 * Retry-After.
 */
const resourceRefused = (
  stage: "authorize" | "exchange",
  error: OAuthProtocolFailed,
  sent: OAuthResourceIndicator | undefined,
) =>
  error.diagnostics?.providerCode === "invalid_target" && sent !== undefined
    ? new OAuthCompletionFailed({
        cause: causeOf(stage, error),
        ...serviceErrorOf(error),
        reason: "resource_rejected",
        resource: sent,
      })
    : undefined;

const exchangeFailed = (error: OAuthProtocolFailed, sent: OAuthResourceIndicator | undefined) => {
  const refused =
    outcome(error) === "rejected" ? resourceRefused("exchange", error, sent) : undefined;
  if (refused !== undefined) return refused;
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
const callbackFailed = (error: OAuthProtocolFailed, sent: OAuthResourceIndicator | undefined) =>
  (error.code === "OAUTH_AUTHORIZATION_RESPONSE_ERROR"
    ? resourceRefused("authorize", error, sent)
    : undefined) ??
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

export const makeOAuth = (
  db: Query,
  credentials: Credentials,
  crypto: HostCrypto,
  options?: OAuthOptions,
  lifecycle?: ResourceLifecycle,
  background?: BackgroundWork,
) => {
  const hash = (value: string) =>
    crypto.digest
      .digest(Digest.sha256, new TextEncoder().encode(value))
      .pipe(Effect.map(Hex.encode));
  const nextId = crypto.random.uuidV4();
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
  const grantAllowed = (id: FirstPartyOAuthClientId, scope: string | undefined) => {
    const client = firstPartyClients.get(id);
    if (client === undefined) return false;
    const grantable = grantableScopes(client);
    return (grantedScopes(client, scope) ?? []).every((granted) => grantable.includes(granted));
  };
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
        ...(server.resource === undefined ? {} : { resource: server.resource }),
      };
    });
  const operatingGrant = (grant: OAuthGrant) =>
    Effect.gen(function* () {
      if (!isFirstPartyGrant(grant)) return grant;
      const operator = yield* operatorClient(grant.firstParty);
      if (operator === undefined) return undefined;
      const { firstParty: _firstParty, generation: _generation, ...rest } = grant;
      return { ...rest, ...operator };
    });

  const grantClientKind = (grant: OAuthGrant): OAuthClientKind =>
    isFirstPartyGrant(grant)
      ? { kind: "first_party", id: grant.firstParty }
      : grant.grant !== "client_credentials" && grant.oauthClient !== undefined
        ? { kind: "stored" }
        : grant.grant !== "client_credentials" && grant.connectionClient !== undefined
          ? { kind: "connection" }
          : { kind: "entered" };

  const renewalOf = (protocol: ReturnType<typeof makeOAuthProtocol>, grant: OAuthGrant) =>
    Effect.gen(function* () {
      const operating = yield* operatingGrant(grant);
      if (operating === undefined) return undefined;
      const clientKind = grantClientKind(grant);
      const attributes = clientSpanAttributes(
        clientKind,
        operating.client.token_endpoint_auth_method,
        { name: "token_endpoint", url: operating.server.token_endpoint },
      );
      if (operating.grant === "client_credentials")
        return { attributes, request: protocol.clientCredentials({ ...operating, clientKind }) };
      const { refreshToken } = operating;
      return refreshToken === undefined
        ? undefined
        : { attributes, request: protocol.refresh({ ...operating, clientKind, refreshToken }) };
    });

  const firstPartyClient = (
    discovered: {
      readonly grant: string;
      readonly server: OAuthTokenServer;
      readonly scopes: readonly string[];
      readonly scopesAdvertised?: true | undefined;
    },
    reconnecting?: FirstPartyOAuthClientId,
  ): {
    readonly offered?: {
      readonly client: FirstPartyOAuthClient;
      readonly scopes: readonly string[];
    };
    readonly refused?: OperatorScopeRefusal;
  } => {
    if (discovered.grant !== "authorization_code") return {};
    const { server } = discovered;
    let refused: OperatorScopeRefusal | undefined;
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
        return { offered: { client, scopes } };
      }
      const scopes = discovered.scopes.length === 0 ? client.defaultScopes : discovered.scopes;
      const [first, ...others] = scopes.filter((scope) => !allowed.includes(scope));
      if (first === undefined) return { offered: { client, scopes } };
      const held = (client.heldScopes ?? []).map((entry) => entry.scope);
      if (![first, ...others].some((scope) => held.includes(scope))) continue;
      refused ??= {
        client: client.label,
        scopes: [first, ...others],
        instead: (client.heldScopes ?? []).flatMap((held) => {
          const [replacement, ...rest] = held.instead;
          return [first, ...others].includes(held.scope) && replacement !== undefined
            ? [{ scope: held.scope, scopes: [replacement, ...rest] }]
            : [];
        }),
      };
    }
    return refused === undefined ? {} : { refused };
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
      return yield* setupOf(yield* storedProvider(input.provider), input);
    });

  const storedProvider = (id: ProviderId) =>
    Effect.gen(function* () {
      const row = yield* query(() => db.findFirst("providers", { where: (b) => b("id", "=", id) }));
      if (row === null) return yield* new ProviderNotFound({ provider: id });
      return yield* decode(Provider, row);
    });

  const setupOf = (
    provider: Provider,
    input: { readonly method: string; readonly redirectUri?: string | undefined },
  ) =>
    Effect.gen(function* () {
      if (protocol === undefined || options === undefined)
        return yield* new OAuthSetupFailed({ reason: "unsupported" });
      yield* Effect.annotateCurrentSpan("oauth.provider.id", provider.id);
      const method = Object.hasOwn(provider.definition.auth, input.method)
        ? provider.definition.auth[input.method]
        : undefined;
      if (method === undefined || method.type !== "oauth2")
        return yield* new AuthMethodInvalid({ provider: provider.id, method: input.method });
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
      const registration =
        discovered.grant === "authorization_code"
          ? clientRegistration(
              discovered.server,
              method.tokenEndpointAuthMethod,
              options.clientMetadataUrl,
            )
          : "manual";
      const previous =
        redirect === undefined
          ? []
          : (options.previousRedirectUris ?? []).flatMap((uri) => {
              const url = parseEndpoint(uri, options.urlPolicy);
              return url === undefined || url.href === redirect.href ? [] : [url];
            });
      const issuer = oauthClientIssuer(discovered.server);
      return { method, redirect, discovered, registration, previous, issuer };
    });
  type Resolved = Effect.Success<ReturnType<typeof resolveSetup>>;

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
  const unexpired = (secret: StoredClientSecret, now: number) =>
    secret.client_secret_expires_at === undefined ||
    secret.client_secret_expires_at === 0 ||
    secret.client_secret_expires_at * 1000 > now;

  const signInCallback = (automatic: string | null, owner: OwnerId, resolved: Resolved) =>
    Effect.gen(function* () {
      if (automatic === null) return resolved.redirect;
      for (const candidate of resolved.previous)
        if ((yield* automaticKey(owner, candidate, resolved)) === automatic) return candidate;
      return resolved.redirect;
    });

  const storedRow = (id: OAuthClientId, input: ClientScope) =>
    query(() => db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", id) })).pipe(
      Effect.map((row) => (row === null || !inScope(row, input) ? undefined : row)),
    );

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
  const registrationCredentials = (client: OAuthRegistration) => ({
    client_id: client.client_id,
    ...(client.token_endpoint_auth_method === "none" || client.client_secret === undefined
      ? {}
      : { client_secret: client.client_secret }),
  });

  const credentialsHolder = (input: ClientScope, client: OAuthRegistration, usedAt?: string) =>
    Effect.gen(function* () {
      const details = registrationCredentials(client);
      const found = yield* credentialsOwner(db, yield* digestOf(input, details));
      if (found !== undefined) return found;
      if (usedAt !== undefined && usedAt !== input.issuer) {
        const elsewhere = yield* credentialsOwner(
          db,
          yield* digestOf({ owner: input.owner, issuer: usedAt }, details),
        );
        if (elsewhere !== undefined) return unusableHere(elsewhere);
      }
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

  const clientAuthorized = (row: unknown) =>
    lifecycle?.oauthClientResolving === undefined
      ? Effect.succeed(true)
      : clientMetadata(row).pipe(Effect.flatMap(lifecycle.oauthClientResolving));

  const storedClient = (id: OAuthClientId, input: SignInScope, resolved: Resolved) =>
    Effect.gen(function* () {
      const row = yield* storedRow(id, { ...input, issuer: resolved.issuer });
      if (row === undefined) return yield* new OAuthClientNotFound({ client: id });
      return yield* useStoredClient(row, input, resolved).pipe(
        Effect.catchTag("OAuthClientNotFound", () => new OAuthClientNotFound({ client: id })),
      );
    });

  const useStoredClient = (row: StoredClientRow, input: SignInScope, resolved: Resolved) =>
    Effect.gen(function* () {
      if (!(yield* clientAuthorized(row))) return yield* new OAuthClientNotFound({});
      const secret = yield* decrypt(row.id, row.encrypted, StoredClientSecret);
      return yield* authorizedClientUse(row, secret, input, resolved);
    });

  const authorizedClientUse = (
    row: StoredClientRow,
    secret: StoredClientSecret,
    input: SignInScope,
    resolved: Resolved,
  ) =>
    Effect.gen(function* () {
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

  const oauthSetup = (input: typeof CheckOAuthSetup.Type) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSetup(input);
      const { discovered, method, registration } = resolved;
      const existing = yield* existingAutomatic(input.owner, resolved);
      const operating = existing === undefined ? firstPartyClient(discovered) : {};
      const firstParty = operating.offered;
      const mode =
        existing === undefined && firstParty === undefined && registration === "manual"
          ? ("client-required" as const)
          : ("automatic" as const);
      const refusal =
        mode === "client-required" && operating.refused !== undefined
          ? { operatorScopeRefusal: operating.refused }
          : {};
      const resource =
        firstParty !== undefined
          ? sentResource(firstParty.client.server.resource, "operator")
          : sentResource(discovered.resource, discovered.resourceSource);
      if (resource === undefined)
        return yield* Effect.die(new Error("OAuth discovery recorded no resource source"));
      if (method.grant === "client_credentials")
        return {
          mode,
          scopes: discovered.scopes,
          grant: method.grant,
          tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
          resource,
        } satisfies OAuthClientSetup;
      const operator =
        firstParty === undefined ? {} : { firstParty: { label: firstParty.client.label } };
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
        ...refusal,
        scopes: firstParty?.scopes ?? discovered.scopes,
        grant: "authorization_code",
        issuer: HttpUrl.make(resolved.issuer),
        ...operator,
        ...(discovered.tokenEndpointAuthMethod === undefined
          ? {}
          : { tokenEndpointAuthMethod: discovered.tokenEndpointAuthMethod }),
        ...(user.length === 0 ? {} : { userScopes: user }),
        ...(firstParty === undefined && registration === "dynamic" ? { chooseAgain: true } : {}),
        resource,
      } satisfies OAuthClientSetup;
    }).pipe(Effect.withSpan("oauth.setup"));

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
        provider: row.issuer === null ? row.provider : null,
        client: row.id,
        createdAt: new Date(yield* Clock.currentTimeMillis),
        reclaim: true,
      });
      if (holder !== undefined) return yield* new OAuthClientExists({ client: holder });
      yield* query(() =>
        db.updateMany("storedOAuthClients", {
          where: (b) => b.and(b("id", "=", row.id), b("owner", "=", input.owner)),
          set: { ...updated, automaticKey: null, confirmed: false, encrypted },
        }),
      );
      return yield* clientMetadata({ ...row, ...updated });
    });

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
      const discovered = yield* Effect.forEach(
        methods,
        ({ name, method }) =>
          protocol.discover(method).pipe(
            Effect.mapError(discoveryFailed),
            Effect.map((found) => ({
              method: name,
              issuer: HttpUrl.make(oauthClientIssuer(found.server)),
            })),
            Effect.result,
          ),
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(discovered, (result) => Effect.fromResult(result));
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
      const operating = firstPartyClient(discovered, reconnecting);
      const firstParty = operating.offered;
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
        return yield* operating.refused === undefined
          ? new OAuthClientUnavailable(input)
          : new OAuthSetupFailed({
              reason: "operator_scope_refused",
              operatorScopes: operating.refused,
              ...(redirect === undefined ? {} : { callbackUrl: HttpUrl.make(redirect.href) }),
            });
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const { client } = yield* protocol
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
      const used = stored.stored ? row : yield* storedRow(stored.holder, scope);
      if (used === undefined) return yield* new OAuthClientNotFound({});
      return { kind: "stored" as const, ...(yield* useStoredClient(used, input, resolved)) };
    }).pipe(Effect.withSpan("oauth.clients.automatic"));

  const noAutomaticClient = (error: unknown): error is OAuthClientUnavailable | OAuthSetupFailed =>
    Schema.is(OAuthClientUnavailable)(error) ||
    (Schema.is(OAuthSetupFailed)(error) && error.reason === "operator_scope_refused");

  const ownerAccounts = (owner: OwnerId) =>
    query(() =>
      db.findMany("accounts", {
        select: ["id", "provider", "method", "label", "description", "owner", "createdAt"],
        where: (b) => b("owner", "=", owner),
      }),
    ).pipe(Effect.flatMap((rows) => decode(Schema.Array(Account), rows)));

  const actorAccounts = (accounts: ReadonlyArray<Account>) =>
    lifecycle === undefined || !Arr.isReadonlyArrayNonEmpty(accounts)
      ? Effect.succeed(accounts)
      : lifecycle
          .accountsResolving(accounts)
          .pipe(Effect.map((allowed) => accounts.filter((account) => allowed.has(account.id))));

  const grantsAt = (accounts: ReadonlyArray<Account>, issuer: string) =>
    Effect.gen(function* () {
      if (accounts.length === 0) return { held: [], unreadable: 0 };
      const rows = yield* query(() =>
        db.findMany("oauthGrants", {
          where: (b) =>
            b(
              "id",
              "in",
              accounts.map((account) => account.id),
            ),
        }),
      );
      const held: Array<{
        readonly account: AccountId;
        readonly clientId: string;
        readonly connection: boolean;
      }> = [];
      let unreadable = 0;
      for (const row of rows) {
        const account = AccountId.make(row.id);
        const read = yield* Effect.option(decrypt(account, row.encrypted, OAuthGrant));
        if (Option.isNone(read)) {
          unreadable++;
          continue;
        }
        const grant = read.value;
        if (
          isFirstPartyGrant(grant) ||
          grant.grant === "client_credentials" ||
          oauthClientIssuer(grant.server) !== issuer
        )
          continue;
        held.push({
          account,
          clientId: grant.client.client_id,
          connection: grant.connectionClient !== undefined,
        });
      }
      if (unreadable > 0)
        yield* Effect.annotateCurrentSpan("oauth.connection_client.unreadable_grants", unreadable);
      return { held, unreadable };
    });

  const storedClientNamed = (owner: OwnerId, issuer: string, clientId: string) =>
    query(() =>
      db.findFirst("storedOAuthClients", {
        where: (b) =>
          b.and(b("owner", "=", owner), b("issuer", "=", issuer), b("clientId", "=", clientId)),
      }),
    ).pipe(Effect.map((row) => row !== null));

  const ownClient = (input: SignInScope, resolved: Resolved, replacing?: AccountId) =>
    Effect.gen(function* () {
      const { method, redirect, discovered, issuer } = resolved;
      const unavailable = (reason: OAuthOwnClientUnavailable) =>
        Effect.annotateCurrentSpan("oauth.connection_client.outcome", reason).pipe(
          Effect.as({ unavailable: reason }),
        );
      if (
        protocol === undefined ||
        discovered.grant !== "authorization_code" ||
        resolved.registration !== "dynamic"
      )
        return yield* unavailable("registration_refused");
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      const { held } = yield* grantsAt(yield* ownerAccounts(input.owner), issuer);
      const live = new Set(
        held
          .filter((entry) => entry.connection && entry.account !== replacing)
          .map((entry) => entry.clientId),
      );
      if (live.size >= connectionClientsPerServer) return yield* unavailable("limit_reached");
      const registered = yield* protocol
        .register(discovered.server, redirect, discovered.scopes, method.tokenEndpointAuthMethod)
        .pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.annotateCurrentSpan(
              "oauth.connection_client.refusal",
              registrationFailed(error, HttpUrl.make(redirect.href)).reason,
            ).pipe(Effect.as(Option.none())),
          ),
        );
      if (Option.isNone(registered)) return yield* unavailable("registration_refused");
      const { client, management } = registered.value;
      if (
        (client.token_endpoint_auth_method === "client_secret_basic_raw" &&
          client.client_id.includes(":")) ||
        held.some((entry) => entry.clientId === client.client_id) ||
        (yield* storedClientNamed(input.owner, issuer, client.client_id)) ||
        (yield* credentialsHolder({ ...input, issuer }, client)) !== undefined
      )
        return yield* unavailable("registration_refused");
      yield* Effect.annotateCurrentSpan("oauth.connection_client.outcome", "registered");
      return {
        kind: "connection" as const,
        client,
        callback: redirect,
        connection: management ?? {},
      };
    }).pipe(Effect.withSpan("oauth.clients.connection"));

  const holdsSharedConsent = (owner: OwnerId, issuer: string, shared: string) =>
    Effect.gen(function* () {
      const { held } = yield* grantsAt(yield* actorAccounts(yield* ownerAccounts(owner)), issuer);
      return held.some((entry) => entry.connection || entry.clientId === shared);
    }).pipe(Effect.withSpan("oauth.clients.further"));

  const retireConnectionClient = (owner: OwnerId, grant: OAuthGrant) =>
    Effect.gen(function* () {
      if (
        isFirstPartyGrant(grant) ||
        grant.grant === "client_credentials" ||
        grant.connectionClient === undefined
      )
        return;
      const { registrationClientUri, registrationAccessToken } = grant.connectionClient;
      const outcome = yield* Effect.gen(function* () {
        if (
          protocol === undefined ||
          registrationClientUri === undefined ||
          registrationAccessToken === undefined
        )
          return "unsupported" as const;
        const issuer = oauthClientIssuer(grant.server);
        const { held, unreadable } = yield* grantsAt(yield* ownerAccounts(owner), issuer);
        if (unreadable > 0) return "unknown_use" as const;
        if (held.some((entry) => entry.clientId === grant.client.client_id))
          return "in_use" as const;
        if (yield* storedClientNamed(owner, issuer, grant.client.client_id))
          return "in_use" as const;
        const stored = yield* credentialsOwner(
          db,
          yield* digestOf({ owner, issuer }, registrationCredentials(grant.client)),
        );
        if (stored !== undefined) return "in_use" as const;
        const status = yield* protocol.deleteClient({
          registrationClientUri,
          registrationAccessToken,
        });
        yield* Effect.annotateCurrentSpan("oauth.client_deletion.status", status);
        return status === 200 || status === 204 ? ("deleted" as const) : ("refused" as const);
      }).pipe(
        Effect.catch(() => Effect.succeed("failed" as const)),
        Effect.catchDefect(() => Effect.succeed("failed" as const)),
      );
      yield* Effect.annotateCurrentSpan("oauth.client_deletion.outcome", outcome);
    }).pipe(Effect.withSpan("oauth.clients.delete"));

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
      const reconnecting =
        previous !== undefined && isFirstPartyGrant(previous) ? previous.firstParty : undefined;
      const withOwnClient = <
        C extends { readonly kind: "stored" | "entered" | "connection" | "firstParty" },
      >(
        chosen: C,
        wanted: boolean,
      ) =>
        Effect.gen(function* () {
          if (!wanted || chosen.kind === "firstParty" || resolved.registration !== "dynamic")
            return chosen;
          const own = yield* ownClient(input, resolved, existing?.id);
          return "unavailable" in own ? { ...chosen, ownClientUnavailable: own.unavailable } : own;
        });
      const ownGrant =
        automatic &&
        previous !== undefined &&
        !isFirstPartyGrant(previous) &&
        previous.grant !== "client_credentials" &&
        (previous.grant ?? "authorization_code") === discovered.grant &&
        previous.connectionClient !== undefined
          ? previous
          : undefined;
      const ownRecord = ownGrant?.connectionClient;
      if (existing !== undefined && ownGrant !== undefined && ownRecord !== undefined) {
        const shared = yield* existingAutomatic(input.owner, resolved);
        if (
          shared === undefined &&
          (resolved.registration === "client_id_metadata_document" ||
            firstPartyClient(discovered, reconnecting).offered !== undefined)
        )
          return yield* automaticChoice(input, resolved, reconnecting);
        const usable =
          ownRecord.rejected !== true &&
          oauthClientIssuer(ownGrant.server) === resolved.issuer &&
          unexpired(ownGrant.client, yield* Clock.currentTimeMillis) &&
          (ownGrant.redirectUri === undefined || ownGrant.redirectUri === redirect?.href);
        if (usable)
          return yield* withOwnClient(
            {
              kind: "connection" as const,
              client: ownGrant.client,
              callback: redirect,
              connection: ownRecord,
            },
            input.chooseAgain === true,
          );
        const own = yield* ownClient(input, resolved, existing.id);
        if (!("unavailable" in own)) return own;
        return {
          ...(yield* automaticChoice(input, resolved, reconnecting)),
          ownClientUnavailable: own.unavailable,
        };
      }
      if (choice === undefined) {
        const reusable =
          previous === undefined ||
          isFirstPartyGrant(previous) ||
          (previous.grant ?? "authorization_code") !== discovered.grant
            ? undefined
            : previous;
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
        if (holder?.kind === "withdrawn")
          return yield* withOwnClient(
            yield* automaticChoice(input, resolved, reconnecting).pipe(
              Effect.catchTag("OAuthClientUnavailable", () =>
                Effect.fail(new OAuthClientNotFound({})),
              ),
            ),
            input.chooseAgain === true && existing !== undefined,
          );
        const kept = holder?.row;
        if (kept !== undefined) {
          const keep = useStoredClient(kept, input, resolved).pipe(
            Effect.map((use) => ({ kind: "stored" as const, ...use })),
          );
          if (kept.source === "manual")
            return yield* withOwnClient(
              yield* keep,
              input.chooseAgain === true && existing !== undefined,
            );
          return yield* withOwnClient(
            yield* automaticChoice(input, resolved, reconnecting).pipe(
              Effect.catchIf(noAutomaticClient, () => keep),
            ),
            input.chooseAgain === true && existing !== undefined,
          );
        }
        const chosen = yield* automaticChoice(input, resolved, reconnecting).pipe(
          Effect.catchIf(noAutomaticClient, (error) =>
            reusable === undefined
              ? Effect.fail(error)
              : Effect.succeed({
                  kind: "entered" as const,
                  client: reusable.client,
                  callback: clientCallback(reusable.client, redirect),
                }),
          ),
        );
        return yield* withOwnClient(
          chosen,
          existing !== undefined
            ? input.chooseAgain === true
            : yield* furtherConnection(input, resolved, chosen),
        );
      }
      if (Schema.is(OAuthClientReference)(choice)) {
        if (discovered.grant === "client_credentials")
          return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        return { kind: "stored" as const, ...(yield* storedClient(choice.id, input, resolved)) };
      }
      if (Schema.is(OAuthAutomaticClient)(choice)) {
        const chosen = yield* automaticChoice(input, resolved, reconnecting);
        return yield* withOwnClient(
          chosen,
          existing !== undefined
            ? input.chooseAgain === true
            : yield* furtherConnection(input, resolved, chosen),
        );
      }
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

  const furtherConnection = (
    input: SignInScope,
    resolved: Resolved,
    chosen: {
      readonly kind: string;
      readonly use?: OAuthClientUse;
      readonly client?: OAuthRegistration;
    },
  ) =>
    chosen.kind !== "stored" ||
    chosen.use?.source !== "registered" ||
    chosen.client === undefined ||
    resolved.registration !== "dynamic"
      ? Effect.succeed(false)
      : holdsSharedConsent(input.owner, resolved.issuer, chosen.client.client_id);

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
      const connection = chosen.kind === "connection" ? chosen.connection : undefined;
      const unavailable =
        "ownClientUnavailable" in chosen ? chosen.ownClientUnavailable : undefined;
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
          .clientCredentials({
            ...discovered,
            client: confidential,
            clientKind: { kind: chosen.kind },
          })
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
                : yield* lockedAccount(tx, { account: account.id, owner: input.owner });
            const saved = stored ?? {
              ...account,
              label: input.label ?? (yield* defaultLabel(tx, input.owner, input.provider)),
              description: null,
            };
            if (stored === undefined) {
              yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
              if (lifecycle) yield* lifecycle.accountCreated(saved);
            } else {
              yield* query(() =>
                tx.updateMany("accounts", {
                  where: (b) => b("id", "=", stored.id),
                  set: {
                    encryptedCredentials,
                    credentialGeneration: stored.credentialGeneration + 1,
                  },
                }),
              );
              yield* resumeWaitingSources(tx, stored.id);
            }
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
      const prompt =
        input.chooseAgain === true &&
        existing !== undefined &&
        (input.client === undefined || Schema.is(OAuthAutomaticClient)(input.client)) &&
        (discovered.server.prompt_values_supported?.includes("consent") === true ||
          discovered.scopes.includes("openid"))
          ? { prompt: "consent" }
          : {};
      const authorization = yield* protocol
        .authorize({ ...discovered, client: registered, redirectUri: redirect.href, ...prompt })
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
        ...(connection === undefined ? {} : { connectionClient: connection }),
        response: method.response,
      });
      const started = yield* saveAttempt(input, id, attempt, authorization.authorizationUrl);
      return unavailable === undefined
        ? started
        : { ...started, ownClientUnavailable: unavailable };
    }).pipe(Effect.withSpan("oauth.beginOAuth"));

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
          ...(label === undefined ? {} : { label }),
        },
        existing,
      ).pipe(
        Effect.tapError((error) =>
          Schema.is(OAuthSetupFailed)(error)
            ? recordSignInFailure(db, crypto, input, connection.oauthAttempt, error)
            : Effect.void,
        ),
      );
    }).pipe(Effect.withSpan("oauth.startOAuth"));

  const reconnectTarget = (tx: Query, attempt: typeof OAuthAttemptRecord.Type) =>
    Effect.gen(function* () {
      const row = yield* lockedAccount(tx, { account: attempt.account, owner: attempt.owner }).pipe(
        Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)),
      );
      if (row === undefined || row.provider !== attempt.provider || row.method !== attempt.method) {
        return yield* new OAuthCompletionFailed({ reason: "account_unavailable" });
      }
      return row;
    });

  const failed = (reason: OAuthCompletionReason) => new OAuthCompletionFailed({ reason });
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
      if (row.status !== "pending") return yield* failed("sign_in_used");
      const now = yield* Clock.currentTimeMillis;
      if (row.expiresAt.getTime() <= now) return yield* failed("sign_in_expired");
      const raw = yield* decrypt(id, row.encrypted, JsonObject);
      const attempt = yield* decode(OAuthAttemptRecord, raw);
      yield* Effect.annotateCurrentSpan("oauth.provider.id", attempt.provider);
      return { callback, id, attempt, legacySavedClient: Object.hasOwn(raw, "savedClient") };
    });

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
      if (legacySavedClient) return yield* failed("client_unavailable");
      const storedRef = isFirstPartyAttempt(attempt) ? undefined : attempt.storedClient;
      const scope: ClientScope | undefined = isFirstPartyAttempt(attempt)
        ? undefined
        : { ...attempt, issuer: oauthClientIssuer(attempt.server) };
      const named =
        storedRef === undefined || scope === undefined
          ? undefined
          : yield* storedRow(storedRef.id, scope);
      if (named !== undefined && !(yield* clientAuthorized(named)))
        return yield* failed("client_unavailable");
      const holder =
        isFirstPartyAttempt(attempt) || scope === undefined || named !== undefined
          ? undefined
          : yield* credentialsHolder(scope, attempt.client);
      if (storedRef !== undefined && holder === undefined && named === undefined)
        return yield* failed("client_unavailable");
      if (holder?.kind === "withdrawn") {
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
      const sent = sentResource(
        operating.resource,
        isFirstPartyAttempt(attempt) ? "operator" : attempt.resourceSource,
      );
      const ownConnection =
        isFirstPartyAttempt(attempt) ||
        (named ?? holding) !== undefined ||
        attempt.connectionClient === undefined
          ? undefined
          : { clientId: attempt.client.client_id, management: attempt.connectionClient };
      const clientKind: OAuthClientKind = isFirstPartyAttempt(attempt)
        ? { kind: "first_party", id: attempt.firstParty }
        : (named ?? holding) !== undefined
          ? { kind: "stored" }
          : ownConnection !== undefined
            ? { kind: "connection" }
            : { kind: "entered" };
      const parameters = yield* protocol
        .callback({ ...operating, clientKind }, callback)
        .pipe(Effect.mapError((error) => callbackFailed(error, sent)));
      const tokens = yield* protocol.exchange({ ...operating, clientKind }, parameters).pipe(
        Effect.mapError((error) => exchangeFailed(error, sent)),
        Effect.catchIf(
          (error) => error.reason === "invalid_client" && ownConnection !== undefined,
          (error) =>
            Effect.gen(function* () {
              const earlier =
                attempt.reconnect === true &&
                (yield* rejectConnectionClient(attempt.account, {
                  clientId: ownConnection?.clientId,
                  issuer: isFirstPartyAttempt(attempt)
                    ? undefined
                    : oauthClientIssuer(attempt.server),
                }));
              return yield* new OAuthCompletionFailed({
                reason: earlier ? "registered_client_rejected" : "registered_client_incompatible",
                ...(error.cause === undefined ? {} : { cause: error.cause }),
                ...(error.serviceError === undefined ? {} : { serviceError: error.serviceError }),
              });
            }),
        ),
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
      yield* Effect.annotateCurrentSpan(
        "oauth.grant.refresh_token",
        tokens.refresh_token !== undefined,
      );
      const completedAt = yield* Clock.currentTimeMillis;
      const issued = {
        response: attempt.response,
        fields,
        redirectUri: attempt.redirectUri,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...expiry(completedAt, tokens.expires_in),
      };
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
                ...(oauthClient === undefined && ownConnection !== undefined
                  ? { connectionClient: ownConnection.management }
                  : {}),
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
          if (current.oauthAttempt !== id) return yield* failed("sign_in_replaced");
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
          const generation = target === undefined ? 0 : target.credentialGeneration + 1;
          if (target !== undefined) {
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", target.id),
                set: { encryptedCredentials, credentialGeneration: generation },
              }),
            );
            yield* resumeWaitingSources(tx, target.id);
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
          if (savedClient !== undefined)
            yield* createStoredClient(tx, savedClient.row, savedClient.digest);
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

  const rejectConnectionClient = (
    account: AccountId,
    client: { readonly clientId: string | undefined; readonly issuer: string | undefined },
  ) => {
    const markOnce = (write: boolean) =>
      Effect.gen(function* () {
        const row = yield* query(() =>
          db.findFirst("oauthGrants", { where: (b) => b("id", "=", account) }),
        );
        if (row === null) return "absent" as const;
        const grant = yield* decrypt(account, row.encrypted, OAuthGrant);
        if (
          isFirstPartyGrant(grant) ||
          grant.grant === "client_credentials" ||
          grant.connectionClient === undefined ||
          grant.client.client_id !== client.clientId ||
          oauthClientIssuer(grant.server) !== client.issuer
        )
          return "absent" as const;
        if (grant.connectionClient.rejected === true) return "marked" as const;
        if (!write) return "unmarked" as const;
        const encrypted = yield* encrypt(account, {
          ...grant,
          connectionClient: { ...grant.connectionClient, rejected: true },
        });
        yield* query(() =>
          db.updateMany("oauthGrants", {
            where: (b) => b.and(b("id", "=", account), b("encrypted", "=", row.encrypted)),
            set: { encrypted },
          }),
        );
        return "written" as const;
      });
    return Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = yield* markOnce(true);
        if (outcome === "absent") return false;
        if (outcome === "marked") return true;
      }
      return (yield* markOnce(false)) === "marked";
    }).pipe(Effect.orElseSucceed(() => false));
  };

  const resolveCredentials = (
    purpose: CredentialPurpose,
    account: StoredAccount,
    provider: ProviderDefinition,
    resolution: Resolution,
    rejection?: Rejection,
  ) =>
    Effect.gen(function* () {
      const rejected = rejection?.fields;
      yield* Effect.annotateCurrentSpan(
        credentialAccess(purpose, account, provider, yield* CurrentActor),
      );
      if (rejected !== undefined)
        yield* Effect.annotateCurrentSpan("oauth.renewal.trigger", "credentials_rejected");
      if (provider.auth[account.method]?.type === "secrets") {
        const app = rejection?.app;
        const offered =
          rejected !== undefined && app !== undefined && lifecycle?.secretsRejected !== undefined
            ? lifecycle.secretsRejected
            : undefined;
        if (offered !== undefined) resolution.contested = true;
        const replaced =
          offered === undefined || rejected === undefined || app === undefined
            ? undefined
            : yield* offered({
                app,
                account: { id: account.id, owner: account.owner, provider: account.provider },
                generation: account.credentialGeneration,
                rejected: Redacted.make(rejected),
              }).pipe(
                Effect.catchTag("StorageError", () => Effect.succeed(false)),
                Effect.flatMap((renewed) =>
                  renewed
                    ? ownedAccount(db, { account: account.id, owner: account.owner }).pipe(
                        Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)),
                      )
                    : Effect.succeed(undefined),
                ),
              );
        const current = replaced ?? account;
        if (replaced !== undefined)
          yield* Effect.annotateCurrentSpan("oauth.renewal.secrets", "replaced");
        return {
          fields: yield* credentials.decrypt(current.id, current.encryptedCredentials),
          firstParty: undefined,
          generation: current.credentialGeneration,
        } satisfies AccountCredential;
      }
      const reconnect = (reason: ReconnectReason, cause?: OAuthFailureCause) =>
        reconnectRequired("oauth.resolve", account.id, reason, cause);
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
        const abandoned = claimed;
        const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant);
        const renewable = grant.grant === "client_credentials" || grant.refreshToken !== undefined;
        const refused = rejected !== undefined && sameFields(grant.fields, rejected);
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
        const renewal = yield* renewalOf(protocol, grant);
        if (renewal === undefined) return yield* reconnect("not_renewable");
        const claim = `refresh_${yield* nextId}`;
        const recorded: { claimedAt?: Date; lost?: "tokens" | OAuthFailureCause } = {};
        const settle = Effect.gen(function* () {
          const result = yield* renewal.request.pipe(
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
            const settled = yield* transaction(db, (tx) =>
              Effect.gen(function* () {
                const current = yield* query(() =>
                  tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
                );
                if (current?.status !== claim) return false;
                yield* query(() =>
                  tx.updateMany("oauthGrants", {
                    where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
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
            if (abandoned)
              yield* Effect.annotateCurrentSpan(
                "oauth.renewal.abandoned_claim_age_ms",
                now - row.updatedAt.getTime(),
              );
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
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const { claimedAt, lost } = recorded;
              if (claimedAt === undefined) return;
              const releasedAt = yield* Clock.currentTimeMillis;
              const unconfirmed = now - row.updatedAt.getTime();
              const reconnected =
                Exit.isSuccess(exit) && Schema.is(OAuthReconnectRequired)(exit.value)
                  ? exit.value
                  : undefined;
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
                    ...renewal.attributes,
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

  type UsableCheck = {
    readonly account: StoredAccount;
    readonly provider: ProviderDefinition;
  };
  const grantedIds = (checks: ReadonlyArray<UsableCheck>) => [
    ...new Set(
      checks
        .filter(({ account, provider }) => provider.auth[account.method]?.type !== "secrets")
        .map(({ account }) => account.id),
    ),
  ];
  const usableGrants = (ids: readonly AccountId[]) =>
    (ids.length === 0
      ? Effect.succeed([])
      : query(() => db.findMany("oauthGrants", { where: (b) => b("id", "in", ids) }))
    ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, row] as const))));
  const usableWith = (checks: ReadonlyArray<UsableCheck>, grants: ReadonlyMap<string, GrantRow>) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("oauth.usable.accounts", checks.length);
      for (const { account, provider } of checks) {
        yield* Effect.annotateCurrentSpan("oauth.provider.id", account.provider);
        if (provider.auth[account.method]?.type === "secrets") continue;
        const reconnect = (reason: ReconnectReason) =>
          reconnectRequired("oauth.usable", account.id, reason);
        const row = grants.get(account.id);
        if (row === undefined) return yield* reconnect("grant_missing");
        if (row.status === "reconnect") return yield* reconnect("grant_unusable");
        if (!row.status.startsWith("ready_")) continue;
        const now = yield* Clock.currentTimeMillis;
        const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant);
        const renewable = grant.grant === "client_credentials" || grant.refreshToken !== undefined;
        if (
          grant.expiresAt === undefined ||
          grant.expiresAt > now + 30_000 ||
          (!renewable && grant.expiresAt > now)
        )
          continue;
        if (protocol === undefined || !renewable) return yield* reconnect("not_renewable");
      }
    }).pipe(
      Effect.withSpan("oauth.usable"),
      Effect.flatMap((checked) =>
        Schema.is(OAuthReconnectRequired)(checked) ? Effect.fail(checked) : Effect.void,
      ),
    );
  const usableAll = (checks: ReadonlyArray<UsableCheck>) =>
    Effect.flatMap(usableGrants(grantedIds(checks)), (grants) => usableWith(checks, grants));
  const usableEach = (selections: ReadonlyArray<ReadonlyArray<UsableCheck>>) =>
    Effect.flatMap(usableGrants(grantedIds(selections.flat())), (grants) =>
      Effect.forEach(selections, (checks) => Effect.result(usableWith(checks, grants))),
    );

  const authorized = (accounts: readonly StoredAccount[]) =>
    lifecycle === undefined || !Arr.isReadonlyArrayNonEmpty(accounts)
      ? Effect.succeed(undefined)
      : lifecycle.accountsResolving(accounts);
  const enforced = (
    current: Effect.Effect<ReadonlySet<AccountId> | undefined, StorageError>,
    accounts: readonly StoredAccount[],
  ) =>
    Effect.flatMap(current, (allowed) =>
      allowed === undefined || accounts.every((account) => allowed.has(account.id))
        ? Effect.void
        : Effect.fail(new AccountUseRefused()),
    );
  const resolveAuthorized = (
    purpose: CredentialPurpose,
    account: StoredAccount,
    provider: ProviderDefinition,
    allowed: ReadonlySet<AccountId> | undefined,
    resolution: Resolution,
    rejection?: Rejection,
    recheck: Effect.Effect<void, StorageError | AccountUseRefused> = enforced(
      authorized([account]),
      [account],
    ),
  ) =>
    Effect.gen(function* () {
      if (allowed !== undefined && !allowed.has(account.id)) return yield* new AccountUseRefused();
      const fields = yield* resolveCredentials(purpose, account, provider, resolution, rejection);
      if (resolution.contested) yield* recheck;
      return fields;
    });
  const resolve = (account: StoredAccount, provider: ProviderDefinition, rejected?: JsonObject) =>
    Effect.flatMap(authorized([account]), (allowed) =>
      resolveAuthorized(
        "resolve",
        account,
        provider,
        allowed,
        { contested: false },
        rejected === undefined ? undefined : { fields: rejected },
      ),
    ).pipe(Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())));
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
  const selectionAuthorized = (
    use: CredentialUse,
    selection: ReadonlyArray<{ readonly account: StoredAccount } & AccountUses>,
  ) =>
    enforced(
      selectionAuthority(use, selection),
      selection.map(({ account }) => account),
    );
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
    Effect.gen(function* () {
      const supplied = yield* GrantReadAhead;
      const [checked, readAhead] =
        supplied === undefined
          ? yield* inOrder(authority, selectionGrants(selected))
          : [yield* authority, supplied];
      const recheck = selectionAuthorized(use, selected);
      return yield* Effect.forEach(selected, ({ account, provider }) =>
        Effect.gen(function* () {
          const credential = yield* resolveAuthorized(
            use.kind,
            account,
            provider,
            checked,
            { contested: false },
            undefined,
            recheck,
          );
          return (definition: ProviderDefinition) =>
            invocationAccount(account, definition, credential, firstPartyClients);
        }),
      ).pipe(Effect.provideService(GrantReadAhead, readAhead));
    });
  const selectionGrants = (
    selected: ReadonlyArray<{
      readonly account: StoredAccount;
      readonly provider: ProviderDefinition;
    }>,
  ) =>
    Effect.gen(function* () {
      const ids = selected
        .filter(({ account, provider }) => provider.auth[account.method]?.type !== "secrets")
        .map(({ account }) => account.id);
      if (ids.length === 0) return undefined;
      const rows = yield* query(() =>
        db.findMany("oauthGrants", { where: (b) => b("id", "in", ids) }),
      );
      const byId = new Map<AccountId, GrantRow | null>(ids.map((id) => [id, null]));
      for (const row of rows) if (byId.has(row.id as AccountId)) byId.set(row.id as AccountId, row);
      return byId;
    });
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
      resolveAuthorized(
        use.kind,
        account,
        provider,
        undefined,
        { contested: false },
        { fields: rejected, app: use.kind === "run" ? use.app : undefined },
        recheck,
      ),
    ).pipe(Effect.catchTag("AccountUseRefused", () => Effect.fail(new StorageError())));
  };
  /**
   * RFC 7009 revocation with the grant's own client, at its server's revocation endpoint. The
   * refresh token is revoked when present, since that also ends its access tokens at most
   * services; otherwise the access token. The token type is recorded on the span; values never are.
   */
  const revokeTokens = (
    grant: { readonly server: OAuthTokenServer; readonly client: OAuthRegistration },
    clientKind: OAuthClientKind,
    tokens: { readonly refreshToken: string | undefined; readonly accessToken: unknown },
  ) =>
    Effect.gen(function* () {
      const revocationEndpoint = grant.server.revocation_endpoint;
      if (protocol === undefined || revocationEndpoint === undefined) return "unsupported" as const;
      const { refreshToken, accessToken } = tokens;
      const token =
        refreshToken !== undefined
          ? { token: refreshToken, tokenTypeHint: "refresh_token" as const }
          : typeof accessToken === "string" && accessToken !== ""
            ? { token: accessToken, tokenTypeHint: "access_token" as const }
            : undefined;
      if (token === undefined) return "no_token" as const;
      yield* Effect.annotateCurrentSpan("oauth.revocation.token_type_hint", token.tokenTypeHint);
      yield* protocol.revoke({
        server: { ...grant.server, revocation_endpoint: revocationEndpoint },
        client: grant.client,
        clientKind,
        ...token,
      });
      return "revoked" as const;
    });
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
  const revokeLater = (revocation: Effect.Effect<void>) =>
    background === undefined
      ? revocation
      : background(revocation).pipe(
          Effect.flatMap((accepted) => (accepted ? Effect.void : revocation)),
        );

  const revokeGrant = (
    removed: {
      readonly account: AccountId;
      readonly owner: OwnerId;
      readonly provider: string;
      readonly encrypted: Uint8Array;
    },
    deadline?: Duration.Input,
  ) => {
    const revocation = Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("oauth.provider.id", removed.provider);
      const stored = yield* decrypt(removed.account, removed.encrypted, OAuthGrant);
      const grant = yield* operatingGrant(stored);
      if (grant === undefined) return "unsupported" as const;
      return yield* revokeTokens(grant, grantClientKind(stored), {
        refreshToken: grant.grant === "client_credentials" ? undefined : grant.refreshToken,
        accessToken: grant.fields["access_token"],
      });
    });
    const retirement = decrypt(removed.account, removed.encrypted, OAuthGrant).pipe(
      Effect.flatMap((grant) => retireConnectionClient(removed.owner, grant)),
      Effect.ignore,
    );
    return settledRevocation(
      deadline === undefined ? revocation : Effect.timeout(revocation, deadline),
      "oauth.revokeGrant",
    ).pipe(
      Effect.andThen(
        deadline === undefined
          ? retirement
          : background === undefined
            ? Effect.void
            : background(retirement).pipe(Effect.asVoid),
      ),
    );
  };
  const revokeRemoved = (removed: Parameters<typeof revokeGrant>[0]) =>
    revokeLater(revokeGrant(removed));
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
              : revokeTokens(operator, { kind: "first_party", id }, tokens),
          ),
        ),
        "oauth.revokeRefused",
      ),
    );

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

  return {
    revocation,
    clients,
    connections: { oauthSetup, startOAuth, completeOAuth },
    findOAuth,
    resolve: (account: StoredAccount, provider: ProviderDefinition) => resolve(account, provider),
    resolveSelected,
    renewRejected,
    usableAll,
    usableEach,
    revokeRemoved,
    revokeGrant,
  };
};
