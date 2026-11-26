import { DashboardApi } from "./dashboard.ts";
import { LocalAppManagementApi, LocalFrameworkApi } from "./app-management.ts";
import { ExecutorApi, RequestRejection } from "@executor-js/sdk/core";
import { HttpApi, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountConnectApi } from "./account-connections.ts";
import { LocalWebhookSetupApi } from "./webhook-setup.ts";
import { LocalFeedbackApi } from "./feedback.ts";

export const LocalExecutorApi = HttpApi.make("executor").add(
  ExecutorApi.groups.accounts,
  ExecutorApi.groups.accountConnections,
  ExecutorApi.groups.oauthClients,
  ExecutorApi.groups.apps,
  ExecutorApi.groups.skills,
  ExecutorApi.groups.tools,
  ExecutorApi.groups.schedules,
  ExecutorApi.groups.appData,
  ExecutorApi.groups.webhooks,
  ExecutorApi.groups.appWorkflows,
  ExecutorApi.groups.appWorkflowRuns,
  ExecutorApi.groups.publications,
  ExecutorApi.groups.registry,
);

const dashboard = DashboardApi.groups.dashboard.endpoints;
const connect = AccountConnectApi.groups.accountConnect.endpoints;
const api = HttpApi.make("local-management")
  .add(ExecutorApi.groups.apps)
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
    HttpApiGroup.make("appAccounts").add(
      dashboard.appList,
      dashboard.appGet,
      dashboard.appLink,
      dashboard.appUnlink,
      connect.appConnect,
      dashboard.userList,
      dashboard.userGet,
      dashboard.userLink,
      dashboard.userUnlink,
      connect.userConnect,
    ),
  )
  .add(LocalWebhookSetupApi.groups.webhookLinks)
  .addHttpApi(LocalAppManagementApi)
  .addHttpApi(LocalFrameworkApi)
  .addHttpApi(LocalFeedbackApi);

export const localManagementDocument = (): OpenApi.OpenAPISpec => {
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, middleware }) => {
      if (![...middleware].some((service) => service.key === RequestRejection.key))
        throw new Error(
          `Management API endpoint ${group.identifier}.${endpoint.identifier} must declare request rejections.`,
        );
    },
  });
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
