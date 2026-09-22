import { deleteOrganizationRecords } from "./organization-records.ts";
/** Removal is one durable workflow. The request only refuses, hides and starts it. */
import { organizationIconKey } from "./organization-icons.ts";
import { requireOrganizationOwner } from "./access.ts";
import { Effect } from "effect";
import { Authentication } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  OrganizationIcons,
  organizationOwner,
  type OrganizationId,
} from "../contracts/organization.ts";
import {
  OrganizationBilling,
  OrganizationRemovals,
  type OrganizationRemovalRetries,
  type OrganizationRemovalStepRunner,
} from "../contracts/organization-removal.ts";

export { deleteOrganizationRecords };

/**
 * Every step is retried by the engine, so the policies differ only in how long
 * a step is worth waiting for. Provider calls get the longest backoff; the
 * local database steps get a short one, because a failing database is either
 * back quickly or a failure an operator has to see.
 */
const providerRetries: OrganizationRemovalRetries = {
  limit: 5,
  delay: "30 seconds",
  backoff: "exponential",
};
const storeRetries: OrganizationRemovalRetries = {
  limit: 5,
  delay: "5 seconds",
  backoff: "linear",
};

/**
 * Accept a removal: check authority, refuse for work the caller can still
 * finish, then write the tombstone. From the moment the tombstone commits no
 * request resolves this organization, so the erasure that follows races with
 * nothing. The counts describe what the organization held when it was accepted.
 *
 * The caller starts the workflow afterwards. It must use the returned instance
 * id, which is the organization id, so accepting the same removal twice adopts
 * the first run instead of starting a second over the same records.
 */
export const beginOrganizationRemoval = Effect.gen(function* () {
  const current = yield* requireOrganizationOwner;
  const executor = yield* Effect.flatten(HostedExecutor);
  const removals = yield* OrganizationRemovals;
  const organization = current.organization;
  const owner = current.owner;
  // Refusals a retry would clear: a running workflow, a pinned account. Taking
  // them here keeps a transient refusal free, because nothing is hidden yet.
  yield* executor.owners.check({ owner });
  const apps = yield* executor.apps.list({ owner });
  const accounts = yield* executor.accounts.list({ owner });
  const record = yield* removals.begin(organization, organization);
  return {
    started: { organization, apps: apps.length, accounts: accounts.length },
    instance: record.instance,
  };
});

/**
 * The erasure itself, as ordered idempotent steps. Nothing here is reversible,
 * and there is no transaction across the systems it touches, so each step is
 * written to complete when its work is already done: a purge repeats safely, a
 * missing organization row means an earlier attempt deleted it, and an expired
 * subscription is already cancelled. Only a genuine outage fails a step.
 */
export const removeOrganizationDurably = <R = never>(
  organization: OrganizationId,
  step: OrganizationRemovalStepRunner<R>,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const authentication = yield* Authentication;
    const icons = yield* OrganizationIcons;
    const removals = yield* OrganizationRemovals;
    const billing = yield* OrganizationBilling;
    const owner = organizationOwner(organization);
    yield* step(
      "unregister-webhooks",
      providerRetries,
      Effect.gen(function* () {
        const apps = yield* executor.apps.list({ owner });
        for (const app of apps) {
          const subscriptions = yield* executor.webhooks.list({ app: app.id });
          for (const subscription of subscriptions)
            if (subscription.status !== "stopped")
              yield* executor.webhooks.remove({ app: app.id, subscription: subscription.id }).pipe(
                // The subscription or its app is already gone, or the provider
                // has already stopped it. Either way there is nothing to release.
                Effect.catchTags({
                  WebhookNotFound: () => Effect.void,
                  AppNotFound: () => Effect.void,
                  WebhookFailed: (error) =>
                    error.reason === "inactive" ? Effect.void : Effect.fail(error),
                }),
              );
        }
      }),
    );
    yield* step("purge-owner-store", storeRetries, executor.owners.remove({ owner }));
    yield* step(
      "delete-auth-records",
      storeRetries,
      authentication.removeOrganization(organization).pipe(
        Effect.flatMap((deleted) => removals.recordLogo(organization, deleted.logo)),
        // A replay after the organization row was already deleted: its icon was
        // recorded on the tombstone by the attempt that deleted it.
        Effect.catchTag("OrganizationForbidden", () => Effect.void),
      ),
    );
    // A request already in flight when the tombstone committed can still have
    // reinstalled this organization's default app. Sweep once more now that no
    // new request can resolve it at all.
    yield* step("resweep-owner-store", storeRetries, executor.owners.remove({ owner }));
    yield* step("cancel-billing", providerRetries, billing.cancel(organization));
    yield* step(
      "release-icon",
      storeRetries,
      Effect.gen(function* () {
        const current = yield* removals.read(organization);
        const key = current === null ? undefined : organizationIconKey(organization, current.logo);
        if (key !== undefined) yield* icons.remove(organization, key);
      }),
    );
    yield* step("finish", storeRetries, removals.finish(organization));
  });
