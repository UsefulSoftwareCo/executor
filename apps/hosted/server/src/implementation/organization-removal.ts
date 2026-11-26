import { deleteOrganizationRecords } from "./organization-records.ts";
import { organizationIconKey } from "./organization-icons.ts";
import { browserOnly, requireOrganizationOwner } from "./access.ts";
import { Effect, Schedule } from "effect";
import { defaultWebhookLifecycleLimits } from "@executor-js/sdk/core";
import { SessionAuthentication } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  OrganizationIcons,
  organizationOwner,
  type OrganizationId,
} from "../contracts/organization.ts";
import {
  OrganizationBilling,
  OrganizationRemovals,
  OrganizationRemovalFailed,
  type OrganizationRemovalRetries,
  type OrganizationRemovalStepRunner,
} from "../contracts/organization-removal.ts";

export { deleteOrganizationRecords };

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

export const previewOrganizationRemoval = Effect.gen(function* () {
  const current = yield* requireOrganizationOwner;
  const executor = yield* Effect.flatten(HostedExecutor);
  const apps = yield* executor.apps.list({ owner: current.owner });
  const accounts = yield* executor.accounts.list({ owner: current.owner });
  return { organization: current.organization, apps: apps.length, accounts: accounts.length };
});

export const beginOrganizationRemoval = Effect.gen(function* () {
  yield* browserOnly;
  const started = yield* previewOrganizationRemoval;
  const executor = yield* Effect.flatten(HostedExecutor);
  const removals = yield* OrganizationRemovals;
  const organization = started.organization;
  const owner = organizationOwner(organization);
  yield* executor.owners.check({ owner });
  const record = yield* removals.begin(organization, organization);
  return {
    started,
    instance: record.instance,
  };
});

export const removeOrganizationDurably = <R = never>(
  organization: OrganizationId,
  step: OrganizationRemovalStepRunner<R>,
) =>
  Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const authentication = yield* SessionAuthentication;
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
                Effect.retry({
                  while: (error) => error._tag === "WebhookConflict",
                  schedule: Schedule.spaced("500 millis"),
                  times: Math.ceil(defaultWebhookLifecycleLimits.leaseMs / 500),
                }),
                Effect.flatMap((stopped) =>
                  stopped.status === "stopped"
                    ? Effect.void
                    : Effect.fail(
                        new OrganizationRemovalFailed({
                          organization,
                          step: "unregister-webhooks",
                        }),
                      ),
                ),
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
        Effect.catchTag("OrganizationForbidden", () => Effect.void),
      ),
    );
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
