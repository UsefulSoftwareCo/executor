import { actorManagerOwner } from "./access.ts";
import { requireAccountOwner } from "./resource-policy.ts";
import type { WebhookId } from "@executor-js/sdk/core";
/** Private setup shares SDK state without making secret exchange available to MCP credentials. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { AppId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { SessionAuthentication, CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  organizationOwner,
  type OrganizationReference,
} from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
const authorized = (
  auth: typeof SessionAuthentication.Service,
  input: { organization: OrganizationReference; app: AppId; subscription: WebhookId },
) =>
  Effect.gen(function* () {
    const organization = yield* auth.organization(input.organization);
    const principal = yield* CurrentPrincipal;
    const membership = yield* auth.membership(principal, organization);
    const access = { organization, role: membership.role, owner: organizationOwner(organization) };
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* executor.apps.get({ owner: organizationOwner(organization), app: input.app });
    yield* Effect.gen(function* () {
      const subscription = yield* executor.webhooks.get(input);
      // An app-account webhook has no actor: it is the app's, so managing the app suffices, as it
      // does for unlinking its account. A member's webhook also needs them to own its account.
      yield* actorManagerOwner(input.app, subscription.actor);
      if (subscription.actor !== null) yield* requireAccountOwner(subscription.sourceAccount);
    }).pipe(
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(CurrentUserId, principal.userId),
    );
    return executor;
  });
/** RequireBrowserSession owns cookie authentication and CSRF; this group owns explicit organization resource checks. */
export const hostedWebhookSetupHandlers = HttpApiBuilder.group(
  HostedApi,
  "webhookSetup",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* SessionAuthentication;
      return handlers
        .handle("read", ({ params }) =>
          Effect.flatMap(authorized(auth, params), (executor) =>
            executor.webhookSetup.read(params),
          ),
        )
        .handle("complete", ({ params, payload }) =>
          Effect.flatMap(authorized(auth, params), (executor) =>
            executor.webhookSetup.complete({ ...params, ...payload }),
          ).pipe(
            // A finished setup is new intent for the webhook source waiting on it.
            Effect.tap(() => Effect.flatten(ScheduleWakeup)),
          ),
        )
        .handle("remove", ({ params }) =>
          Effect.flatMap(authorized(auth, params), (executor) => executor.webhooks.remove(params)),
        )
        .handle("confirmRemoval", ({ params }) =>
          Effect.flatMap(authorized(auth, params), (executor) =>
            executor.webhooks.confirmRemoval(params),
          ),
        );
    }),
);
