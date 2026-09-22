import { deleteOrganizationRecords } from "./organization-records.ts";
/** One ordered removal: providers, then product storage, then identity, then the icon. */
import { organizationIconKey } from "./organization-icons.ts";
import { requireOrganizationOwner } from "./access.ts";
import { Effect } from "effect";
import { Authentication } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationIcons } from "../contracts/organization.ts";

export { deleteOrganizationRecords };

/**
 * A host composes this into its own API group. Nothing here is reversible, so
 * the order matters: a provider registration that cannot be released stops the
 * whole removal while the organization is still usable.
 */
export const removeCurrentOrganization = Effect.gen(function* () {
  const organization = yield* requireOrganizationOwner;
  const authentication = yield* Authentication;
  const icons = yield* OrganizationIcons;
  const executor = yield* Effect.flatten(HostedExecutor);
  const owner = organization.owner;
  // Unregistering at a provider cannot be undone: a stopped subscription burns its
  // stable key for good. Take the refusals a retry would hit -- a running workflow,
  // a pinned account -- before that, so a transient refusal leaves the organization
  // whole. Live webhook state is deliberately not part of this check: the sweep
  // below is what clears it.
  yield* executor.owners.check({ owner });
  const apps = yield* executor.apps.list({ owner });
  for (const app of apps) {
    const subscriptions = yield* executor.webhooks.list({ app: app.id });
    for (const subscription of subscriptions)
      if (subscription.status !== "stopped")
        yield* executor.webhooks.remove({ app: app.id, subscription: subscription.id });
  }
  const removed = yield* executor.owners.remove({ owner });
  const record = yield* authentication.removeOrganization(organization.organization);
  // A concurrent inventory read can reinstall this organization's default app
  // while it still exists. Sweep once more now that no request can resolve it.
  yield* executor.owners.remove({ owner });
  const key = organizationIconKey(organization.organization, record.logo);
  if (key !== undefined) yield* icons.remove(organization.organization, key);
  return {
    organization: organization.organization,
    apps: removed.apps,
    accounts: removed.accounts,
  };
});
