import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { Executor } from "@executor-js/sdk/core";
import { DashboardApi } from "../contracts/dashboard.ts";
import type { ServerConfig } from "../contracts/config.ts";
import type { LocalAuth } from "./auth.ts";
import { browserOnly } from "./dashboard.ts";

export const localWorkflowInputHandlers = (
  executor: Executor,
  config: ServerConfig,
  auth: LocalAuth,
) =>
  HttpApiBuilder.group(DashboardApi, "workflowInputs", (handlers) =>
    handlers
      .handle("list", ({ query }) => executor.workflowInputs.list(query))
      .handle("get", ({ params }) =>
        browserOnly(config, auth).pipe(Effect.andThen(executor.workflowInputs.get(params))),
      )
      .handle("answer", ({ params, payload }) =>
        browserOnly(config, auth).pipe(
          Effect.andThen(executor.workflowInputs.answer({ ...params, ...payload })),
        ),
      )
      .handle("updateEvidence", ({ params, payload }) =>
        executor.workflowInputs.updateEvidence({ ...params, ...payload }),
      )
      .handle("withdraw", ({ params }) => executor.workflowInputs.withdraw(params)),
  );
