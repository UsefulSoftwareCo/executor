import { DashboardApi } from "./dashboard.ts";
import { LocalAppManagementApi } from "./app-management.ts";
/** The local agent-facing API, projected from the contracts that serve its requests. */
import { ExecutorApi } from "@executor-js/sdk/core";
import { HttpApi, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AccountConnectApi } from "./account-connections.ts";
import { LocalWebhookSetupApi } from "./webhook-setup.ts";

const api = HttpApi.make("local-management")
  .add(ExecutorApi.groups.apps)
  .add(ExecutorApi.groups.appProfiles)
  .add(ExecutorApi.groups.skills)
  .add(ExecutorApi.groups.accounts)
  .add(ExecutorApi.groups.webhooks)
  .add(ExecutorApi.groups.appWorkflows)
  .add(ExecutorApi.groups.appWorkflowRuns)
  .add(
    HttpApiGroup.make("schedules").add(
      DashboardApi.groups.schedules.endpoints.list,
      DashboardApi.groups.schedules.endpoints.definitions,
      DashboardApi.groups.schedules.endpoints.configure,
      DashboardApi.groups.schedules.endpoints.runNow,
      DashboardApi.groups.schedules.endpoints.runs,
    ),
  )
  .add(HttpApiGroup.make("tools").add(ExecutorApi.groups.tools.endpoints.list))
  .add(
    HttpApiGroup.make("accountConnections").add(
      ExecutorApi.groups.accountConnections.endpoints.get,
      ExecutorApi.groups.accountConnections.endpoints.cancel,
    ),
  )
  .add(
    HttpApiGroup.make("accountConnect").add(
      AccountConnectApi.groups.accountConnect.endpoints.issue,
    ),
  )
  .add(LocalWebhookSetupApi.groups.webhookLinks)
  .addHttpApi(LocalAppManagementApi);

/** Browser secret exchange, raw delivery, subscriptions and approval protocols are not management tools. */
export const localManagementDocument = (): OpenApi.OpenAPISpec => {
  const document = OpenApi.fromApi(api);
  return {
    ...document,
    components: {
      ...document.components,
      securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
    },
    paths: Object.fromEntries(
      Object.entries(document.paths)
        .filter(([path]) => !path.endsWith("/deliver"))
        .map(([path, methods]) => [
          path,
          {
            ...methods,
            ...Object.fromEntries(
              (["get", "post", "put", "patch", "delete", "head", "options"] as const)
                .filter((method) => methods[method] !== undefined)
                .map((method) => [method, { ...methods[method], security: [{ apiKey: [] }] }]),
            ),
          },
        ]),
    ),
  };
};
