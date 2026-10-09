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
import type { OAuthClientId, OAuthAttemptId } from "./oauth.ts";

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
/** The host owns encryption and key custody. Ciphertexts are bound to their stable resource identity. */
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
}
