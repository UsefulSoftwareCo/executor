import { DashboardApi } from "./dashboard.ts";
import { LocalAppManagementApi, LocalFrameworkApi } from "./app-management.ts";
/** The local agent-facing API, projected from the contracts that serve its requests. */
import { ExecutorApi, RequestRejection } from "@executor-js/sdk/core";
import { HttpApi, HttpApiGroup, OpenApi } from "effect/http-api";
import { AccountConnectApi } from "./account-connections.ts";
import { LocalWebhookSetupApi } from "./webhook-setup.ts";
import { LocalFeedbackApi } from "./feedback.ts";

/**
 * The SDK routes local serves: every group but the owner lifecycle. Local's owners are fixed,
 * `local` for the user's records and `executor-local` for the server's own Executor app, so
 * removing an owner would only ever delete all of the user's data or that app. Hosted removes an
 * organization's owner in process, never through these routes.
 */
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
/**
 * Each app's account links, named `appAccounts.<scope>.<action>` for tools as on hosted: `app`
 * routes link for every call, `user` routes for the local user. `connect` returns a browser link
 * whose completion links the new account to the requirement.
 */
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

/** Browser secret exchange, raw delivery, subscriptions and approval protocols are not management tools. */
export const localManagementDocument = (): OpenApi.OpenAPISpec => {
  // Agents read each operation's declared errors; an undeclared 400 reaches them without its cause.
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
