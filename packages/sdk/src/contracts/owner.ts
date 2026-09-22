/** Owner lifecycle. Products call this when an owner itself stops existing. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
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
