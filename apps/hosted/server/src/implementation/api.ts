import { hostedProfileHandlers } from "./profiles.ts";
import { appManagementHandlers } from "@executor-js/app-management";
import { HostedAppManagementApi } from "../contracts/app-management.ts";
import { hostedAppAccess } from "../app-management.ts";
import { hostedResourceAccessHandlers } from "./resource-access.ts";
import { hostedScheduleHandlers } from "./schedules.ts";
/** Shared hosted handlers. No Cloudflare, Node, or local-product dependencies. */
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { HostedApi } from "../contracts/api.ts";
import { HostedCatalog } from "../contracts/catalog.ts";
import { ApiAuthentication, CurrentPrincipal } from "../contracts/auth.ts";
import { hostedOrganizationHandlers } from "./organization.ts";
import { hostedAccountHandlers } from "./accounts.ts";
import { hostedAppDataHandlers } from "./app-data.ts";
import { hostedWebhookSetupHandlers } from "./webhook-setup.ts";
import { hostedWorkflowHandlers } from "./workflows.ts";
import { hostedWebhookHandlers } from "./webhooks.ts";
import { hostedToolHandlers } from "./tools.ts";
import { hostedAppHandlers } from "./apps.ts";
import { hostedSkillHandlers } from "./skills.ts";
import { hostedGroupHandlers } from "./groups.ts";

const health = HttpApiBuilder.group(HostedApi, "health", (handlers) =>
  handlers.handle("get", () => Effect.succeed({ status: "ok" as const })),
);

const catalog = HttpApiBuilder.group(HostedApi, "catalog", (handlers) =>
  handlers.handle("list", () => Effect.flatMap(HostedCatalog, (catalog) => catalog.list)),
);

const apiContext = HttpApiBuilder.group(HostedApi, "context", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* ApiAuthentication;
    return handlers.handle("get", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const grant = yield* auth.authenticate(new Headers(request.headers));
        if (grant.key !== undefined)
          yield* Effect.annotateCurrentSpan({
            "executor.api_key.id": grant.key.id,
            "executor.user.id": grant.userId,
          });
        return {
          organization: grant.access.organization,
          slug: grant.organizationSlug,
          role: grant.access.role,
        };
      }),
    );
  }),
);

/** Common group implementations. Each host supplies HostedExecutor and HostedCatalog. */
export const hostedHandlers = Layer.mergeAll(
  appManagementHandlers(HostedAppManagementApi, HostedApi.identifier).pipe(
    Layer.provide(hostedAppAccess),
  ),
  hostedProfileHandlers,
  hostedScheduleHandlers,
  health,
  catalog,
  apiContext,
  hostedOrganizationHandlers,
  hostedGroupHandlers,
  hostedResourceAccessHandlers,
  hostedWebhookSetupHandlers,
  hostedWebhookHandlers,
  hostedWorkflowHandlers,
  hostedAppHandlers,
  hostedSkillHandlers,
  hostedAccountHandlers,
  hostedToolHandlers,
  hostedAppDataHandlers,
  HttpApiBuilder.group(HostedApi, "viewer", (handlers) =>
    handlers.handle("get", () =>
      Effect.gen(function* () {
        return yield* CurrentPrincipal;
      }),
    ),
  ),
);
