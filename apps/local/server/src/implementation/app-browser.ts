import { HttpApiBuilder } from "effect/http-api";
import type { Executor } from "@executor-js/sdk/core";
import type { SqlClient } from "effect/sql";
import { DashboardApi } from "../contracts/dashboard.ts";
import { linkedOperation } from "./app-accounts.ts";

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
