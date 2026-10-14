/** Owner lifecycle. Products call this when an owner itself stops existing. */
import { Schema, type Effect } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { OwnerId, StorageError, WebhookId } from "./shared.ts";
import { AppWorkflowsActive } from "./apps.ts";
import { AccountWorkflowsActive } from "./account.ts";

/** Live provider registrations must be removed first; this operation never silently abandons them. */
export class OwnerWebhooksActive extends Schema.TaggedError<OwnerWebhooksActive>()(
  "OwnerWebhooksActive",
  { owner: OwnerId, subscriptions: Schema.Array(WebhookId) },
  { httpApiStatus: 409 },
) {}

/** What the purge actually deleted, so a product can report and verify the result. */
export const OwnerRemoved = Schema.Struct({
  owner: OwnerId,
  apps: Schema.Int,
  accounts: Schema.Int,
  deployments: Schema.Int,
  connections: Schema.Int,
});
export type OwnerRemoved = typeof OwnerRemoved.Type;

/** A read-only verdict, so a caller can gate irreversible work on a refusal it cannot clear. */
export const OwnerRemovable = Schema.Struct({ owner: OwnerId });
export type OwnerRemovable = typeof OwnerRemovable.Type;

/** Decoded at the Promise boundary; the native operation takes the parsed value. */
export const OwnerInputs = {
  remove: Schema.Struct({ owner: OwnerId }),
  check: Schema.Struct({ owner: OwnerId }),
};

/** Ownership is a storage primitive, not authorization; the caller decides who may do this. */
export const OwnersGroup = HttpApiGroup.make("owners")
  .add(
    HttpApiEndpoint.get("check", "/v1/owners/:owner/removable", {
      params: { owner: OwnerId },
      success: OwnerRemovable,
      error: [StorageError, AppWorkflowsActive, AccountWorkflowsActive],
    }).annotate(
      OpenApi.Description,
      "Report whether a purge would be refused for work in flight: a queued or running workflow, or an account pinned by one. Reads only, and never reports live webhook subscriptions, which the caller clears by removing them at their providers. Call this before any irreversible step so a retryable refusal costs nothing.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/owners/:owner", {
      params: { owner: OwnerId },
      success: OwnerRemoved,
      error: [StorageError, OwnerWebhooksActive, AppWorkflowsActive, AccountWorkflowsActive],
    }).annotate(
      OpenApi.Description,
      "Delete every record belonging to one owner: configured apps, app records, stopped webhooks, saved accounts and their credentials, retained deployments, pending connections, pending approvals, schedules with their run history and completed workflow runs. Remove live webhook subscriptions and finish or terminate active workflows first. Repeating removal is safe.",
    ),
  );

/** Host-only: moving owners' records to another owner, outside the HTTP and Promise facades. */
export const OwnerMovesHost = Symbol("executor.OwnerMoves");

/**
 * Records that cannot all belong to the target owner: apps with one name or one slug, or stored
 * OAuth clients holding the same credentials for one authorization server (for one provider, for
 * clients stored before SDK 4.0.12). `key` is the name, the slug, or the client's issuer (else its
 * provider) and public client ID; it never holds a secret.
 */
export const OwnerMoveCollision = Schema.Struct({
  kind: Schema.Literals(["app_name", "app_slug", "oauth_client_credentials"]),
  key: Schema.String,
  /** Each record under the owner it has now. */
  records: Schema.Array(Schema.Struct({ owner: OwnerId, id: Schema.String })),
});
export type OwnerMoveCollision = typeof OwnerMoveCollision.Type;

/**
 * A record a move has to read but cannot: it does not decrypt with this host's key, or the product
 * would not read it back with the schema it resumes it with. `kind` names the record: a stored
 * OAuth client, an account's OAuth grant, a pending OAuth sign-in, a pending tool approval or an
 * account connection. `owner` is the record's owner column, absent for a sign-in, whose owner is
 * inside what cannot be read. Never its content.
 */
export const OwnerMoveBlocked = Schema.Struct({
  kind: Schema.Literals([
    "oauth_client",
    "oauth_grant",
    "oauth_sign_in",
    "tool_approval",
    "account_connection",
  ]),
  id: Schema.String,
  owner: Schema.optionalKey(OwnerId),
});
export type OwnerMoveBlocked = typeof OwnerMoveBlocked.Type;

/**
 * What a move did or, without `apply`, would do. A collision or a record it cannot read changes
 * no record: `blocked` wins over `collision`, and both list everything found.
 */
export interface OwnerMove {
  readonly status: "moved" | "would_move" | "collision" | "blocked";
  readonly collisions: ReadonlyArray<OwnerMoveCollision>;
  readonly blocked: ReadonlyArray<OwnerMoveBlocked>;
  /** Rows changed, or that would change, per table. */
  readonly rows: Readonly<Record<string, number>>;
}

/**
 * Give every record of some owners to another owner, in one transaction: owner columns, the
 * owner a stored connection target and a pending sign-in or approval names, and the identity of
 * stored OAuth client credentials. Ownership is a storage primitive; the host decides which owners
 * move, and never moves one whose records another product still serves.
 */
export interface OwnerMoves {
  /** Every owner that holds a record. */
  readonly owners: Effect.Effect<ReadonlyArray<OwnerId>, StorageError>;
  readonly move: (input: {
    readonly from: ReadonlyArray<OwnerId>;
    readonly to: OwnerId;
    readonly apply: boolean;
  }) => Effect.Effect<OwnerMove, StorageError>;
}
