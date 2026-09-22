import { requireAppAccess, requireAccountAccess } from "./resource-policy.ts";
import type { WebhookId } from "@executor-js/sdk/core";
/** Private setup shares SDK state without making secret exchange available to MCP credentials. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import type { AppId } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { Authentication, CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  organizationOwner,
  type OrganizationReference,
} from "../contracts/organization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
const authorized = (
  auth: typeof Authentication.Service,
  input: { organization: OrganizationReference; app: AppId; subscription: WebhookId },
  permission: "read" | "use" = "use",
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const organization = yield* auth.organization(input.organization);
    const membership = yield* auth.membership(new Headers(request.headers), organization);
    const principal = yield* CurrentPrincipal;
    const access = { organization, role: membership.role, owner: organizationOwner(organization) };
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* executor.apps.get({ owner: organizationOwner(organization), app: input.app });
    yield* Effect.gen(function* () {
      yield* requireAppAccess(input.app, "manage");
      const subscription = yield* executor.webhooks.get(input);
      for (const account of new Set(Object.values(subscription.accounts).flat()))
        yield* requireAccountAccess(account, permission);
    }).pipe(
      Effect.provideService(CurrentOrganization, access),
      Effect.provideService(CurrentUserId, principal.userId),
    );
    return executor;
  });
/** RequireUser owns cookie authentication and CSRF; this group owns explicit organization resource checks. */
export const hostedWebhookSetupHandlers = HttpApiBuilder.group(
  HostedApi,
  "webhookSetup",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* Authentication;
      return handlers
        .handle("read", ({ params }) =>
          Effect.flatMap(authorized(auth, params), (executor) =>
            executor.webhookSetup.read(params),
          ),
        )
        .handle("complete", ({ params, payload }) =>
          Effect.flatMap(authorized(auth, params), (executor) =>
            executor.webhookSetup.complete({ ...params, ...payload }),
          ),
        )
        .handle("remove", ({ params }) =>
          Effect.flatMap(authorized(auth, params), (executor) => executor.webhooks.remove(params)),
        )
        .handle("confirmRemoval", ({ params }) =>
          Effect.flatMap(authorized(auth, params, "read"), (executor) =>
            executor.webhooks.confirmRemoval(params),
          ),
        );
    }),
);
