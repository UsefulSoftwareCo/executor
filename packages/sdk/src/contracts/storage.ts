import type { WorkflowRunId } from "apps/contracts";
import { appSlug } from "./app-slug.ts";
/** Persisted records. Decode database results with these schemas before use. */
import { Schema, Struct } from "effect";
import { Account } from "./account.ts";
import { App, AppRequirements } from "./apps.ts";
import { Deployment } from "./deployment.ts";
import {
  ApprovalRequestId,
  WebhookId,
  AccountId,
  AppCodeId,
  OwnerId,
  JsonObject,
  CredentialsError,
  StorageError,
} from "./shared.ts";
import { AccountConnectionDestination } from "./account-connection.ts";
import type { Effect, Redacted } from "effect";
import { OAuthProviderErrorCode, type OAuthClientId, type OAuthAttemptId } from "./oauth.ts";

/**
 * Account metadata plus an opaque encrypted credential envelope. The future
 * credential adapter owns its format and keys; plaintext fields are not a
 * database column. Public account responses use Account, not this record.
 */
export const StoredAccount = Schema.Struct({
  ...Account.fields,
  encryptedCredentials: Schema.RedactedFromValue(Schema.Uint8Array),
  credentialGeneration: Schema.Int,
  /** Hosts the account was connected for, or null when it was connected without hosts. */
  allowedHosts: Schema.NullOr(Schema.Array(Schema.String)),
});
/** Parsed account storage record; encrypted bytes remain redacted in memory. */
export type StoredAccount = typeof StoredAccount.Type;

/**
 * Requirements belong to the immutable code version. These are declared
 * account slots, not the account-dependent tool catalog.
 */
export const StoredDeployment = Schema.Struct({
  ...Deployment.mapFields(Struct.omit(["files"])).fields,
  fileCount: Schema.Int.check(Schema.isGreaterThan(0)),
  requirements: AppRequirements,
});
/** Parsed deployment storage record with its declared account requirements. */
export type StoredDeployment = typeof StoredDeployment.Type;

/**
 * An app stores its source identity and active deployment; profiles store selections.
 * Public App.requirements is read from that deployment rather than duplicated.
 */
export const StoredApp = Schema.Struct({
  ...App.mapFields(Struct.omit(["requirements"])).fields,
  deploySequence: Schema.Int,
  activatedSequence: Schema.Int,
}).check(
  Schema.makeFilter((app) => app.slug === appSlug(app.name), {
    message: "The app address must match its current name",
  }),
);
/** Parsed configured app storage record, without derived requirements. */
export type StoredApp = typeof StoredApp.Type;

/**
 * The `accountConnections.state` column. `failure` holds an `AccountConnectionFailure` encoded in
 * the error vocabulary of the release that recorded it. Readers decode it apart from the status:
 * a failure whose reason, stage or code a later release removed is left out, never breaking the
 * connection. See notes/oauth.md, "Failure reasons".
 */
export const StoredConnectionState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), failure: Schema.optional(Schema.Json) }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("completed"), account: Account }),
]);
export type StoredConnectionState = typeof StoredConnectionState.Type;

/** Frozen target intent. Single selections are compared at completion; collections merge with current IDs. */
export const StoredConnectionTarget = Schema.Struct({
  ...AccountConnectionDestination.fields,
  owner: OwnerId,
  cardinality: Schema.Literals(["one", "many"]),
  selection: Schema.NullOr(Schema.Union([AccountId, Schema.Array(AccountId)])),
}).pipe(Schema.encodeKeys({ profile: "installation" }));
export type StoredConnectionTarget = typeof StoredConnectionTarget.Type;

/** Atomic product writes beside SDK writes are host-only, outside the public HTTP/Promise facade. */
export const StorageHost = Symbol("executor.StorageHost");
/**
 * Hosts keep product tables in the same database as the executor. This is the one tracked
 * transaction boundary: product SQL inside it shares the executor's connection, and SDK operations
 * called inside it join the same transaction. Wrapping SDK calls in a raw SQL transaction fails.
 */
export interface StorageHost {
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>;
}
/**
 * A credentials store refused to renew a grant, in the terms of the service's answer. The host
 * classifies it as it classifies its own token request. `subject_changed` ends the grant on its
 * own; `invalid_grant` ends it only with `answer: "error_body"` or the service's `status`, since a
 * refusal that names no answer from the service reads as an incompatible response.
 */
export class CredentialsRenewalRefused extends Schema.TaggedError<CredentialsRenewalRefused>()(
  "CredentialsRenewalRefused",
  {
    reason: Schema.Literals([
      "request",
      "invalid_grant",
      "invalid_client",
      "invalid_response",
      "subject_changed",
    ]),
    status: Schema.optional(Schema.Int),
    providerError: Schema.optional(OAuthProviderErrorCode),
    /** The service answered with an RFC 6749 §5.2 error body, or a WWW-Authenticate challenge. */
    answer: Schema.optional(Schema.Literals(["error_body", "challenge"])),
    /** With HTTP 429, the time the answer's Retry-After header named. */
    retryAfter: Schema.optional(Schema.Date),
  },
) {}

/** A renewal a credentials store performed. */
export interface CredentialsRenewed {
  /** Public token response members. Never refresh_token, id_token, client_secret or client_assertion. */
  readonly tokens: Redacted.Redacted<JsonObject>;
  /**
   * The grant sealed again, holding any rotated refresh token. The host decrypts it, sets the
   * renewed fields and lifetime and encrypts it once more, so `encrypt` keeps the store's own
   * placeholders.
   */
  readonly sealed: Uint8Array;
}

/**
 * The store owns encryption and key custody; a store with `renew` also owns the refresh exchange.
 * Ciphertexts are bound to their stable resource identity.
 */
export interface Credentials {
  readonly encrypt: (
    identity:
      | AccountId
      | AppCodeId
      | OAuthClientId
      | OAuthAttemptId
      | ApprovalRequestId
      | WebhookId
      | WorkflowRunId
      | import("./events.ts").EventSubscriptionId
      | import("./events.ts").StoredEventId,
    fields: Redacted.Redacted<JsonObject>,
  ) => Effect.Effect<Uint8Array, CredentialsError>;
  readonly decrypt: (
    identity:
      | AccountId
      | AppCodeId
      | OAuthClientId
      | OAuthAttemptId
      | ApprovalRequestId
      | WebhookId
      | WorkflowRunId
      | import("./events.ts").EventSubscriptionId
      | import("./events.ts").StoredEventId,
    bytes: Redacted.Redacted<Uint8Array>,
  ) => Effect.Effect<Redacted.Redacted<JsonObject>, CredentialsError>;
  /**
   * Renew an OAuth grant from the store's own sealed copy, so the host never reads its refresh
   * token or client secret. When present, the host calls it instead of its own token request and
   * keeps its claim, lease and outcome classification.
   *
   * The host seals several records under the same identities and still runs sign-in and the
   * client credentials setup exchange itself. So a store may replace `refreshToken` and
   * `client.client_secret` with placeholders only in the grant: a record under an `acc_` identity
   * with `server`, `client`, `fields` and `response` keys. The account fields under the same identity, the sign-in
   * attempt under `oauth_` and the saved client under `client_` (top-level `client_secret`) must
   * decrypt to their real values. The host reads only whether the placeholders are present.
   *
   * Performs the RFC 6749 `refresh_token` or `client_credentials` request, and for a refreshed ID
   * token the OIDC Core §12.2 subject check (reason `subject_changed`). Returns no secret.
   */
  readonly renew?: (
    identity: AccountId,
    sealed: Redacted.Redacted<Uint8Array>,
  ) => Effect.Effect<CredentialsRenewed, CredentialsError | CredentialsRenewalRefused>;
  /**
   * RFC 7009 revocation of a deleted account's grant with the store's real token: the refresh
   * token when present, otherwise the access token. Outcomes match the host's own revocation.
   * The host calls it once, after deleting the account, whatever the outcome; how long the store
   * keeps the grant's secrets after that is the store's decision.
   */
  readonly revoke?: (
    identity: AccountId,
    sealed: Redacted.Redacted<Uint8Array>,
  ) => Effect.Effect<"revoked" | "unsupported" | "no_token" | "failed", CredentialsError>;
}
