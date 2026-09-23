/** Dashboard policy is pairing; the SDK owns account binding and durable execution. */
import type { Executor } from "@executor-js/sdk/core";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DashboardApi } from "../contracts/dashboard.ts";
/** Expose resource operations only inside the paired dashboard API. */
export const localResourceHandlers = (executor: Executor) =>
  Layer.mergeAll(
    HttpApiBuilder.group(DashboardApi, "workflows", (handlers) =>
      handlers
        .handle("definitions", ({ params, query }) =>
          executor.apps.workflows.list({ ...params, ...query }),
        )
        .handle("start", ({ params, payload }) =>
          executor.apps.workflowRuns.start({ ...params, ...payload }),
        )
        .handle("list", ({ params, query }) =>
          executor.apps.workflowRuns.list({ ...params, ...query }),
        )
        .handle("terminate", ({ params }) => executor.apps.workflowRuns.terminate(params)),
    ),
    HttpApiBuilder.group(DashboardApi, "webhooks", (handlers) =>
      handlers
        .handle("list", ({ params, query }) => executor.webhooks.list({ ...params, ...query }))
        .handle("reconcile", ({ params }) => executor.webhooks.reconcile(params)),
    ),
  );
