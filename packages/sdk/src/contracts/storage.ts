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
  OwnerId,
  JsonObject,
  CredentialsError,
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
 * A configured app stores its own account selections and active deployment.
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

/** Frozen target intent. Single selections are compared at completion; collections merge with current IDs. */
export const StoredConnectionTarget = Schema.Struct({
  ...AccountConnectionDestination.fields,
  owner: OwnerId,
  cardinality: Schema.Literals(["one", "many"]),
  selection: Schema.NullOr(Schema.Union([AccountId, Schema.Array(AccountId)])),
}).pipe(Schema.encodeKeys({ profile: "installation" }));
export type StoredConnectionTarget = typeof StoredConnectionTarget.Type;

/** The host owns encryption and key custody. Ciphertexts are bound to the account, client, attempt, or approval-request identity. */
export interface Credentials {
  readonly encrypt: (
    identity:
      | AccountId
      | OAuthClientId
      | OAuthAttemptId
      | ApprovalRequestId
      | WebhookId
      | WorkflowRunId,
    fields: Redacted.Redacted<JsonObject>,
  ) => Effect.Effect<Uint8Array, CredentialsError>;
  readonly decrypt: (
    identity:
      | AccountId
      | OAuthClientId
      | OAuthAttemptId
      | ApprovalRequestId
      | WebhookId
      | WorkflowRunId,
    bytes: Redacted.Redacted<Uint8Array>,
  ) => Effect.Effect<Redacted.Redacted<JsonObject>, CredentialsError>;
}
