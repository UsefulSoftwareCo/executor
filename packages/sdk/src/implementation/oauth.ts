import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { BackgroundWork } from "../contracts/declarations.ts";
/** Trusted OAuth lifecycle. Provider definitions never contain client secrets or saved grants. */
import { parseDestination, parseEndpoint, httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import {
  Array as Arr,
  Clock,
  type Crypto,
  Effect,
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
  OAuthClientId,
  OAuthGrant,
  OAuthReconnectRequired,
  OAuthRegistration,
  OAuthRenewalFailed,
  OAuthConfidentialRegistration,
  OAuthSetupFailed,
  OAuthSavedClientMetadata,
  type OAuthClientSource,
  type OAuthFailureCause,
  type OAuthOptions,
} from "../contracts/oauth.ts";
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
  type OwnerId,
  type ProviderId,
} from "../contracts/shared.ts";
import { StoredAccount, type Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import { storedProfile } from "./profiles.ts";
import {
  clientRegistration,
  fromRefusal,
  idTokenIdentity,
  isOAuthErrorResponse,
  makeOAuthProtocol,
  normalizedTokens,
  OAuthProtocolFailed,
} from "./oauth-protocol.ts";
import { defaultLabel, ownedAccount } from "./accounts.ts";
import type { OAuthCallbackField, OAuthFailureDetail } from "./oauth-diagnostics.ts";

const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));

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
 * The tokens a credentials store's renewal returned, normalized as the host normalizes its own
 * token response, so a store may pass the service's body as it came. RFC 6749 §5.1 gives
 * `expires_in` as a non-negative number, and some services send it as a numeric string, which
 * oauth4webapi accepts on the host's own request; any other shape, including a negative
 * lifetime, is a response Executor cannot use. `project` drops host-only members before
 * anything reaches the account.
 */
const RenewedTokens = Schema.StructWithRest(
  Schema.Struct({
    expires_in: Schema.optional(
      Schema.Union([Schema.Number, Schema.FiniteFromString]).check(
        Schema.isGreaterThanOrEqualTo(0),
      ),
    ),
  }),
  [JsonObject],
);
const renewedTokens = (tokens: Redacted.Redacted<JsonObject>) =>
  Schema.decodeUnknownEffect(RenewedTokens)(normalizedTokens(Redacted.value(tokens))).pipe(
    Effect.mapError(
      () => new OAuthProtocolFailed({ reason: "invalid_response", code: "schema_decode" }),
    ),
  );

/** A renewal's token response, with the grant a credentials store sealed again when it renewed. */
type Renewal = Effect.Effect<
  {
    readonly tokens: { readonly expires_in?: number | undefined; readonly [key: string]: unknown };
    readonly sealed?: Uint8Array | undefined;
  },
  OAuthProtocolFailed
>;

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

/** Why a saved grant cannot supply credentials. Recorded on the resolve and usable spans. */
type ReconnectReason =
  | "grant_missing"
  | "grant_unusable"
  | "renewal_interrupted"
  | "not_renewable"
  | "renewal_refused"
  | "identity_changed";

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
 * Whether resolving credentials waited for, or performed, a renewal. Only then can it outlive a
 * permission change, so only then is product authority checked again afterwards.
 */
interface Resolution {
  contested: boolean;
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
        ...(reason === "renewal_interrupted" ? { reason } : {}),
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
 * Two failures other than `invalid_grant` do end the grant: a token endpoint the host policy now
 * refuses cannot renew this saved grant, and a refreshed ID token for a different end user (OIDC
 * Core §12.2) means the grant no longer belongs to this account's identity. A new sign-in settles
 * both.
 */
const renewalOutcome = (error: OAuthProtocolFailed): "reconnect" | OAuthRenewalFailed["reason"] =>
  error.reason === "subject_changed"
    ? "reconnect"
    : Match.value(outcome(error)).pipe(
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

  const resolveSetup = (input: typeof CheckOAuthSetup.Type, automatic: boolean) =>
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
        return yield* new AuthMethodInvalid(input);
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
      const discovered = yield* protocol.discover(method).pipe(
        Effect.mapError((error) => {
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
              "subject_changed",
              () => "discovery_invalid" as const,
            ),
            Match.exhaustive,
          );
          return new OAuthSetupFailed({
            cause: causeOf("discover", error),
            ...retryAfterOf(reason, error),
            reason,
          });
        }),
      );
      // A client registered for fewer scopes cannot be assumed to allow new ones. Only registered
      // and entered clients are saved, and the metadata URL does not change them, so turning the
      // setting on or off keeps every saved client. The null once held that URL; it stays so
      // clients saved without the setting keep their keys.
      const keyFor = (callback: URL | undefined) =>
        hash(
          JSON.stringify([
            input.owner,
            input.provider,
            input.method,
            callback?.href,
            discovered.server.issuer,
            null,
            [...discovered.scopes].sort(),
          ]),
        ).pipe(Effect.map((digest) => OAuthClientId.make(`client_${digest}`)));
      const now = yield* Clock.currentTimeMillis;
      // Import checks report the same choice for the providers they generate.
      const registration =
        discovered.grant === "authorization_code"
          ? clientRegistration(
              discovered.server,
              method.tokenEndpointAuthMethod,
              options.clientMetadataUrl,
            )
          : "manual";
      // A client saved at a callback this host sent before is registered with that callback only.
      // Executor can replace one it registered or read from its metadata document, so those sign
      // in again at the current callback. Only a client someone entered, or one for a server that
      // offers no other way, keeps sending the old callback, since only its owner can change what
      // the provider allows. A record saved before sources were recorded counts as registered
      // where the server registers clients.
      const previous =
        redirect === undefined
          ? []
          : (options.previousRedirectUris ?? []).flatMap((uri) => {
              const url = parseEndpoint(uri, options.urlPolicy);
              return url === undefined || url.href === redirect.href ? [] : [url];
            });
      let callback = redirect;
      let clientId = yield* keyFor(redirect);
      let client: OAuthRegistration | undefined;
      let reused: { readonly version: Uint8Array; readonly source?: OAuthClientSource } | undefined;
      if (automatic)
        for (const candidate of [redirect, ...previous]) {
          const id = yield* keyFor(candidate);
          const saved = yield* query(() =>
            db.findFirst("oauthClients", { where: (b) => b("id", "=", id) }),
          );
          if (saved === null) continue;
          const registered = yield* decrypt(id, saved.encrypted, OAuthRegistration);
          const metadata = yield* decrypt(id, saved.encrypted, OAuthSavedClientMetadata);
          if (
            candidate !== redirect &&
            metadata.executor_source !== "manual" &&
            registration !== "manual"
          )
            continue;
          if (
            registered.client_secret_expires_at !== undefined &&
            registered.client_secret_expires_at !== 0 &&
            registered.client_secret_expires_at * 1000 <= now
          )
            continue;
          callback = candidate;
          clientId = id;
          client = registered;
          reused = {
            version: saved.encrypted,
            ...(metadata.executor_source === undefined ? {} : { source: metadata.executor_source }),
          };
          break;
        }
      const savedClient = client !== undefined;
      if (automatic && client === undefined && registration === "client_id_metadata_document") {
        const url =
          options.clientMetadataUrl === undefined
            ? undefined
            : parseDestination(options.clientMetadataUrl, httpsOnlyUrlPolicy);
        if (url === undefined) return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        client = { client_id: url.href, token_endpoint_auth_method: "none" };
      }
      return {
        method,
        redirect: callback,
        discovered,
        clientId,
        client,
        savedClient,
        reused,
        registration,
      };
    });
  const oauthSetup = (input: typeof CheckOAuthSetup.Type) =>
    resolveSetup(input, true).pipe(
      Effect.map(({ discovered, method, savedClient, registration }): OAuthClientSetup => {
        const mode = savedClient
          ? "saved"
          : registration === "manual"
            ? "client-required"
            : "automatic";
        if (method.grant === "client_credentials")
          return {
            mode,
            scopes: discovered.scopes,
            grant: method.grant,
            tokenEndpointAuthMethod: method.tokenEndpointAuthMethod,
          };
        const user =
          discovered.grant === "authorization_code"
            ? userScopes(discovered.server.authorization_endpoint, discovered.authorizationParams)
            : [];
        return {
          mode,
          scopes: discovered.scopes,
          grant: "authorization_code",
          ...(discovered.tokenEndpointAuthMethod === undefined
            ? {}
            : { tokenEndpointAuthMethod: discovered.tokenEndpointAuthMethod }),
          ...(user.length === 0 ? {} : { userScopes: user }),
        };
      }),
      Effect.withSpan("oauth.setup"),
    );

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
      const {
        method,
        redirect,
        discovered,
        clientId,
        client: availableClient,
        reused,
        registration,
      } = yield* resolveSetup(input, input.client === undefined);
      /** Where the client came from; a reused client keeps its recorded source, if any. */
      let source: OAuthClientSource | undefined =
        input.client !== undefined ? "manual" : reused === undefined ? "metadata" : reused.source;
      const now = yield* Clock.currentTimeMillis;
      let client: OAuthRegistration | undefined;
      if (input.client !== undefined) {
        if (
          discovered.tokenEndpointAuthMethod === "none" &&
          input.client.clientSecret !== undefined
        )
          return yield* new OAuthSetupFailed({ reason: "invalid_client" });
        client = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
          client_id: input.client.clientId,
          token_endpoint_auth_method:
            discovered.tokenEndpointAuthMethod ??
            (input.client.clientSecret === undefined
              ? "none"
              : secretMethod(discovered.server.token_endpoint_auth_methods_supported)),
          ...(input.client.clientSecret === undefined
            ? {}
            : { client_secret: Redacted.value(input.client.clientSecret) }),
        }).pipe(Effect.mapError(() => new OAuthSetupFailed({ reason: "invalid_client" })));
      } else client = availableClient;
      if (
        client === undefined &&
        discovered.grant === "authorization_code" &&
        registration === "dynamic"
      ) {
        if (redirect === undefined)
          return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
        client = yield* protocol
          .register(discovered.server, redirect, discovered.scopes, method.tokenEndpointAuthMethod)
          .pipe(Effect.mapError((error) => registrationFailed(error, HttpUrl.make(redirect.href))));
        source = "registered";
      }
      if (client === undefined) return yield* new OAuthClientUnavailable(input);
      if (
        client.token_endpoint_auth_method === "client_secret_basic_raw" &&
        client.client_id.includes(":")
      )
        return yield* new OAuthSetupFailed({ reason: "invalid_client" });
      const registered = client;
      const encryptedClient = yield* encrypt(clientId, {
        ...registered,
        ...(source === undefined ? {} : { executor_source: source }),
      });
      const saveClient = (store: Query) =>
        query(() =>
          store.upsert("oauthClients", {
            where: (b) => b("id", "=", clientId),
            create: { id: clientId, encrypted: encryptedClient },
            update: { encrypted: encryptedClient },
          }),
        );
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
                target:
                  current.target === null
                    ? null
                    : {
                        app: current.target.app,
                        profile: yield* storedProfile(tx, {
                          app: current.target.app,
                          profile: current.target.profile,
                        }),
                      },
              });
            yield* finishConnection(tx, claimed, saved);
            yield* saveClient(tx);
            return saved;
          }),
        );
        return { status: "completed" as const, account: saved };
      }
      if (redirect === undefined)
        return yield* new OAuthSetupFailed({ reason: "invalid_redirect" });
      // A metadata document client is the host's configuration, read again on every sign-in.
      const fromDocument = reused === undefined && source === "metadata";
      // Only a client this start registered is saved here. A reused client is already saved, and
      // writing it again could restore one discarded meanwhile; an entered one is saved when its
      // sign-in completes.
      if (reused === undefined && source === "registered") yield* saveClient(db);
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
        ...(input.client !== undefined
          ? { clientKey: clientId }
          : fromDocument
            ? {}
            : {
                savedClient: {
                  key: clientId,
                  version: Base64.encode(reused?.version ?? encryptedClient),
                  ...(source === undefined ? {} : { source }),
                  fresh: reused === undefined,
                },
              }),
        response: method.response,
      });
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
        authorizationUrl: HttpUrl.make(authorization.authorizationUrl),
        expiresAt,
        redirectUri: HttpUrl.make(redirect.href),
      };
    }).pipe(Effect.withSpan("oauth.beginOAuth"));

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

  const reconnectTarget = (tx: Query, attempt: OAuthAttempt) =>
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
      const attempt = yield* decrypt(id, row.encrypted, OAuthAttempt);
      yield* Effect.annotateCurrentSpan("oauth.provider.id", attempt.provider);
      return { callback, id, attempt };
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
      const { callback, id, attempt } = yield* pendingAttempt(input.callbackUrl);
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
      // This completion owns the sign-in now, so whatever ends it is the request's latest outcome.
      return yield* exchangeClaimed(protocol, input, callback, id, attempt).pipe(
        Effect.tapError((error) =>
          Schema.is(OAuthCompletionFailed)(error)
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
    attempt: OAuthAttempt,
  ) =>
    Effect.gen(function* () {
      if (attempt.reconnect) yield* reconnectTarget(db, attempt);
      const parameters = yield* protocol
        .callback(attempt, callback)
        .pipe(Effect.mapError(callbackFailed));
      const tokens = yield* protocol.exchange(attempt, parameters).pipe(
        Effect.mapError(exchangeFailed),
        Effect.catchIf(
          (error) =>
            error.reason === "invalid_client" && attempt.savedClient?.source === "registered",
          (error) =>
            Effect.gen(function* () {
              const saved = attempt.savedClient;
              if (saved === undefined) return yield* error;
              const version = yield* Effect.fromResult(Base64.decode(saved.version)).pipe(
                Effect.mapError(() => new StorageError()),
              );
              // Only the version this attempt used: a client saved since then stays.
              yield* query(() =>
                db.deleteMany("oauthClients", {
                  where: (b) => b.and(b("id", "=", saved.key), b("encrypted", "=", version)),
                }),
              );
              return yield* new OAuthCompletionFailed({
                reason: saved.fresh
                  ? "registered_client_incompatible"
                  : "registered_client_rejected",
                ...(error.cause === undefined ? {} : { cause: error.cause }),
                ...(error.serviceError === undefined ? {} : { serviceError: error.serviceError }),
              });
            }),
        ),
      );
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
      const grant = yield* decode(OAuthGrant, {
        server: attempt.server,
        client: attempt.client,
        response: attempt.response,
        ...(attempt.resource === undefined ? {} : { resource: attempt.resource }),
        ...(attempt.tokenRequestFormat === undefined
          ? {}
          : { tokenRequestFormat: attempt.tokenRequestFormat }),
        ...(attempt.tokenResponse === undefined ? {} : { tokenResponse: attempt.tokenResponse }),
        ...idTokenIdentity(tokens),
        fields,
        ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
        ...expiry(completedAt, tokens.expires_in),
      });
      const encryptedCredentials = yield* encrypt(attempt.account, fields);
      const encryptedGrant = yield* encrypt(attempt.account, grant);
      const savedClient =
        attempt.clientKey === undefined
          ? undefined
          : {
              id: attempt.clientKey,
              encrypted: yield* encrypt(attempt.clientKey, {
                ...attempt.client,
                executor_source: "manual",
              }),
            };
      const ready = `ready_${yield* nextId}`;
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const current = yield* requireOpen(input, yield* lockConnection(tx, input, crypto));
          // A newer sign-in started while the token exchange was running.
          if (current.oauthAttempt !== id) return yield* failed("sign_in_replaced");
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
          if (target !== undefined) {
            // A reconnect may sign in as another upstream identity: start a new generation.
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", target.id),
                set: {
                  encryptedCredentials,
                  credentialGeneration: target.credentialGeneration + 1,
                },
              }),
            );
          } else {
            yield* query(() => tx.create("accounts", { ...saved, encryptedCredentials }));
            if (lifecycle) yield* lifecycle.accountCreated(saved);
          }
          const grant = {
            encrypted: encryptedGrant,
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
              target:
                current.target === null
                  ? null
                  : {
                      app: current.target.app,
                      profile: yield* storedProfile(tx, {
                        app: current.target.app,
                        profile: current.target.profile,
                      }),
                    },
            });
          yield* finishConnection(tx, current, saved);
          if (savedClient !== undefined)
            yield* query(() =>
              tx.upsert("oauthClients", {
                where: (b) => b("id", "=", savedClient.id),
                create: savedClient,
                update: { encrypted: savedClient.encrypted },
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
      if (provider.auth[account.method]?.type === "secrets")
        return yield* credentials.decrypt(account.id, account.encryptedCredentials);
      /** Record why the grant cannot be used on this span; only fixed vocabularies and codes. */
      const reconnect = (reason: ReconnectReason, cause?: OAuthFailureCause) =>
        reconnectRequired("oauth.resolve", account.id, reason, cause);
      // Set once this call has waited for another renewal of the grant. The token it then reads
      // is that renewal's result, and is used until it expires rather than renewed ahead again.
      let awaited = false;
      while (true) {
        const row = yield* query(() =>
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
        if (refused && !renewable) return Redacted.make(grant.fields);
        if (
          !abandoned &&
          !refused &&
          (grant.expiresAt === undefined ||
            grant.expiresAt > now + (awaited ? 0 : 30_000) ||
            (!renewable && grant.expiresAt > now))
        )
          return Redacted.make(grant.fields);
        // Neither the host nor a credentials store can renew a grant without a refresh token; it
        // reconnects, as `usable` reports.
        if (protocol === undefined || options === undefined || !renewable)
          return yield* reconnect("not_renewable");
        const stage = grant.grant === "client_credentials" ? "clientCredentials" : "refresh";
        const store = credentials.renew;
        // A store that renews holds the real refresh token and client secret; the host applies
        // its URL policy to the saved token endpoint, as its own transport would.
        const renewal: Renewal | undefined =
          store !== undefined
            ? parseDestination(grant.server.token_endpoint, options.urlPolicy) === undefined
              ? Effect.fail(new OAuthProtocolFailed({ reason: "destination_blocked" }))
              : store(account.id, Redacted.make(row.encrypted)).pipe(
                  Effect.mapError(fromRefusal),
                  Effect.flatMap(({ tokens, sealed }) =>
                    renewedTokens(tokens).pipe(Effect.map((tokens) => ({ tokens, sealed }))),
                  ),
                )
            : grant.grant === "client_credentials"
              ? protocol.clientCredentials(grant).pipe(Effect.map((tokens) => ({ tokens })))
              : grant.refreshToken === undefined
                ? undefined
                : protocol
                    .refresh({ ...grant, refreshToken: grant.refreshToken })
                    .pipe(Effect.map((tokens) => ({ tokens })));
        if (renewal === undefined) return yield* reconnect("not_renewable");
        const claim = `refresh_${yield* nextId}`;
        /** Renew under the claim and save the outcome; undefined when the claim was lost. */
        const settle = Effect.gen(function* () {
          if (store !== undefined)
            yield* Effect.annotateCurrentSpan("oauth.renewal.custody", "store");
          const result = yield* renewal.pipe(
            Effect.annotateSpans("oauth.provider.id", account.provider),
            Effect.mapError((error) => {
              const outcome = renewalOutcome(error);
              return {
                outcome,
                cause: causeOf(stage, error),
                identityChanged: error.reason === "subject_changed",
                retry: retryAfterOf(outcome, error),
              };
            }),
            Effect.flatMap(({ tokens, sealed }) =>
              project(grant.response, { ...grant.fields, ...tokens }).pipe(
                // The service issued tokens, but not in the shape the provider declares.
                Effect.mapError(() => ({
                  outcome: "incompatible_response" as const,
                  cause: { stage } satisfies OAuthFailureCause,
                  identityChanged: false,
                  retry: {},
                })),
                Effect.map((fields) => ({ tokens, fields, sealed })),
              ),
            ),
            Effect.result,
          );
          if (result._tag === "Failure") {
            const { outcome, cause, identityChanged, retry } = result.failure;
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
            if (!settled) return undefined;
            if (outcome === "reconnect")
              return yield* reconnect(
                identityChanged
                  ? "identity_changed"
                  : abandoned
                    ? "renewal_interrupted"
                    : "renewal_refused",
                cause,
              );
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
              return Redacted.make(grant.fields);
            }
            return yield* new OAuthRenewalFailed({
              account: account.id,
              reason: outcome,
              cause,
              ...retry,
            });
          }
          const { fields, tokens, sealed } = result.success;
          // The service may already have rotated the refresh token the store now holds under its
          // new seal. Keep that seal under the claim before anything else can fail, so a renewal
          // that resumes this abandoned claim starts from it instead of the replaced token. A seal
          // the store returns but cannot open again leaves the grant unusable until a new sign-in.
          if (sealed !== undefined)
            yield* query(() =>
              db.updateMany("oauthGrants", {
                where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                set: { encrypted: sealed },
              }),
            );
          const updatedAt = new Date(yield* Clock.currentTimeMillis);
          // A store that renewed sealed the grant again with any rotated refresh token. Its view of
          // that grant takes the renewed fields and lifetime, and the store seals it once more.
          const renewed =
            sealed === undefined ? grant : yield* decrypt(account.id, sealed, OAuthGrant);
          // The renewed token's lifetime replaces the previous one, including when it states none.
          const updated = yield* decode(OAuthGrant, {
            ...Struct.omit(renewed, ["expiresAt"]),
            fields,
            ...(grant.grant === "client_credentials" || sealed !== undefined
              ? {}
              : {
                  refreshToken:
                    typeof tokens.refresh_token === "string"
                      ? tokens.refresh_token
                      : grant.refreshToken,
                }),
            ...expiry(updatedAt.getTime(), tokens.expires_in),
          });
          const encrypted = yield* encrypt(account.id, updated);
          const encryptedCredentials = yield* encrypt(account.id, fields);
          const ready = `ready_${yield* nextId}`;
          const committed = yield* transaction(db, (tx) =>
            Effect.gen(function* () {
              const current = yield* query(() =>
                tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
              );
              const saved = yield* query(() =>
                tx.findFirst("accounts", { where: (b) => b("id", "=", account.id) }),
              );
              if (current?.status !== claim || saved === null) return false;
              yield* query(() =>
                tx.updateMany("oauthGrants", {
                  where: (b) => b.and(b("id", "=", account.id), b("status", "=", claim)),
                  set: { status: ready, encrypted, updatedAt },
                }),
              );
              yield* query(() =>
                tx.updateMany("accounts", {
                  where: (b) => b("id", "=", account.id),
                  set: { encryptedCredentials },
                }),
              );
              return true;
            }),
          );
          if (!committed) return undefined;
          yield* Effect.annotateCurrentSpan("oauth.renewal.outcome", "renewed");
          return Redacted.make(fields);
        });
        // From claiming the grant to settling it, the renewal cannot be interrupted: a caller that
        // times out or disconnects would otherwise abandon a live claim, and with it any rotated
        // refresh token the service has already issued. The token request is bounded by its own
        // timeout, so an interruption waits at most that long plus the save. With a credentials
        // store, the renewal and the decrypt and two encrypts after it are four calls to the store,
        // so an interruption can wait for all four of their timeouts plus the save.
        resolution.contested = true;
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
                // A failed confirmation is retried at the next beat; the lease spans several.
                Effect.catch(() => Effect.void),
                Effect.forever,
                Effect.interruptible,
              ),
            );
            return yield* settle.pipe(
              Effect.ensuring(
                Fiber.interrupt(heartbeat).pipe(
                  Effect.andThen(Effect.sync(() => heldClaims.delete(claim))),
                ),
              ),
            );
          }),
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
  /**
   * Resolve one account checked in `allowed`, checking again if resolving waited or renewed.
   * `resolution` records whether it did.
   */
  const resolveAuthorized = (
    account: StoredAccount,
    provider: ProviderDefinition,
    allowed: ReadonlySet<AccountId> | undefined,
    resolution: Resolution,
    rejected?: JsonObject,
  ) =>
    Effect.gen(function* () {
      if (allowed !== undefined && !allowed.has(account.id)) return yield* new StorageError();
      const fields = yield* resolveCredentials(account, provider, resolution, rejected);
      // A remote token refresh can outlive a permission change or account deletion.
      if (resolution.contested) {
        const current = yield* authorized([account]);
        if (current !== undefined && !current.has(account.id)) return yield* new StorageError();
      }
      return fields;
    });
  const resolve = (account: StoredAccount, provider: ProviderDefinition, rejected?: JsonObject) =>
    Effect.flatMap(authorized([account]), (allowed) =>
      resolveAuthorized(account, provider, allowed, { contested: false }, rejected),
    );
  /**
   * Resolve each selected account's credentials in order. Product authority for all of them is
   * checked in one read first, and refused in selection order; a caller that checks it with the
   * profile supplies that read. Once one account has waited for or performed a renewal, that read
   * can be seconds old, so each later account is checked again immediately before it resolves.
   */
  const resolveSelected = (
    selected: ReadonlyArray<{
      readonly account: StoredAccount;
      readonly provider: ProviderDefinition;
    }>,
    authority: Effect.Effect<ReadonlySet<AccountId> | undefined, StorageError> = authorized(
      selected.map(({ account }) => account),
    ),
  ) =>
    Effect.flatMap(authority, (checked) => {
      const batch: Resolution = { contested: false };
      return Effect.forEach(selected, ({ account, provider }) =>
        Effect.gen(function* () {
          const allowed = batch.contested ? yield* authorized([account]) : checked;
          const resolution: Resolution = { contested: false };
          const fields = yield* resolveAuthorized(account, provider, allowed, resolution);
          if (resolution.contested) batch.contested = true;
          return fields;
        }),
      );
    });
  /**
   * The service refused these credentials. Renew the grant once, or read a renewal another call
   * already made, and return the account's current credentials. They equal `rejected` when the
   * account cannot be renewed, such as a secrets account or a grant without a refresh token.
   */
  const renewRejected = (
    account: StoredAccount,
    provider: ProviderDefinition,
    rejected: JsonObject,
  ) => resolve(account, provider, rejected);
  /**
   * Best-effort RFC 7009 revocation of a grant whose account was already deleted. The refresh
   * token is revoked when present, since that also ends its access tokens at most services;
   * otherwise the access token. Nothing here can fail or undo the deletion. The outcome and
   * safe protocol evidence are recorded on the span; token values never are.
   */
  const revokeGrant = (removed: {
    readonly account: AccountId;
    readonly provider: string;
    readonly encrypted: Uint8Array;
  }) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("oauth.provider.id", removed.provider);
      if (protocol === undefined) return "unsupported" as const;
      // A store that holds the grant's tokens revokes with them itself.
      if (credentials.revoke !== undefined)
        return yield* credentials.revoke(removed.account, Redacted.make(removed.encrypted));
      const grant = yield* decrypt(removed.account, removed.encrypted, OAuthGrant);
      if (grant.server.revocation_endpoint === undefined) return "unsupported" as const;
      const accessToken = grant.fields["access_token"];
      const token =
        grant.grant !== "client_credentials" && grant.refreshToken !== undefined
          ? { token: grant.refreshToken, tokenTypeHint: "refresh_token" as const }
          : typeof accessToken === "string" && accessToken !== ""
            ? { token: accessToken, tokenTypeHint: "access_token" as const }
            : undefined;
      if (token === undefined) return "no_token" as const;
      yield* Effect.annotateCurrentSpan("oauth.revocation.token_type_hint", token.tokenTypeHint);
      yield* protocol.revoke({ server: grant.server, client: grant.client, ...token });
      return "revoked" as const;
    }).pipe(
      Effect.catch(() => Effect.succeed("failed" as const)),
      Effect.catchDefect(() => Effect.succeed("failed" as const)),
      Effect.tap((outcome) => Effect.annotateCurrentSpan("oauth.revocation.outcome", outcome)),
      Effect.asVoid,
      Effect.withSpan("oauth.revokeGrant"),
    );

  /**
   * Revoke after the deletion commits, beside the response when the host accepts background
   * work (the same hand-off stale declarations use); otherwise inline, bounded by the protocol's
   * request timeout.
   */
  const revokeRemoved = (removed: Parameters<typeof revokeGrant>[0]) =>
    background === undefined
      ? revokeGrant(removed)
      : background(revokeGrant(removed)).pipe(
          Effect.flatMap((accepted) => (accepted ? Effect.void : revokeGrant(removed))),
        );

  return {
    connections: { oauthSetup, startOAuth, completeOAuth },
    findOAuth,
    resolve: (account: StoredAccount, provider: ProviderDefinition) => resolve(account, provider),
    resolveSelected,
    renewRejected,
    usable,
    revokeRemoved,
  };
};
