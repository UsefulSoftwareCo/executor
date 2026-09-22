/** These reads reuse SDK behavior under the ordinary paired dashboard boundary. */
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { Executor } from "@executor-js/sdk/core";
import { DashboardApi } from "../contracts/dashboard.ts";

/** Skill reads never bind accounts. */
export const localAppBrowserHandlers = (executor: Executor) =>
  HttpApiBuilder.group(DashboardApi, "appBrowser", (handlers) =>
    handlers
      .handle("skillBundle", ({ params, query }) => executor.skills.bundle({ ...params, ...query }))
      .handle("skills", ({ params, query }) => executor.skills.list({ ...params, ...query }))
      .handle("skill", ({ params, query }) => executor.skills.read({ ...params, ...query })),
  );
