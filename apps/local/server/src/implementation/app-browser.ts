/** These reads reuse SDK behavior under the ordinary paired dashboard boundary. */
import { HttpApiBuilder } from "effect/http-api";
import type { Executor } from "@executor-js/sdk/core";
import type { SqlClient } from "effect/sql";
import { DashboardApi } from "../contracts/dashboard.ts";
import { linkedOperation } from "./app-accounts.ts";

/**
 * Skill reads with the accounts linked to the app, for the requirements of the deployment the
 * read pins. The dashboard and the programmatic API, which the apps CLI reads, both use them.
 */
export const localSkills = (sql: SqlClient.SqlClient, executor: Executor): Executor["skills"] => {
  const linked = linkedOperation(sql, executor);
  return {
    bundle: linked(executor.skills.bundle),
    list: linked(executor.skills.list),
    read: linked(executor.skills.read),
  };
};

export const localAppBrowserHandlers = (executor: Executor, sql: SqlClient.SqlClient) => {
  const skills = localSkills(sql, executor);
  return HttpApiBuilder.group(DashboardApi, "appBrowser", (handlers) =>
    handlers
      .handle("skillBundle", ({ params, query }) => skills.bundle({ ...params, ...query }))
      .handle("skills", ({ params, query }) => skills.list({ ...params, ...query }))
      .handle("skill", ({ params, query }) => skills.read({ ...params, ...query })),
  );
};
