/** Product-owned browser review; scheduler actions otherwise share the normal local SDK. */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { StorageError, RequestInvalid, type Executor } from "@executor-js/sdk/core";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import { BrowserApprovalView } from "@executor-js/mcp/browser";
import { DashboardApi } from "../contracts/dashboard.ts";
import type { ServerConfig } from "../contracts/config.ts";
import type { LocalAuth } from "./auth.ts";
import { browserOnly } from "./dashboard.ts";
import type { SqlClient } from "effect/sql";
import { callerAccounts, localActor } from "./app-accounts.ts";

/**
 * Authentication is shared with dashboard routes; human decisions additionally require a browser
 * cookie. The local subject has one copy of each declaration.
 */
export const localScheduleHandlers = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  config: ServerConfig,
  auth: LocalAuth,
) =>
  HttpApiBuilder.group(DashboardApi, "schedules", (handlers) =>
    handlers
      .handle("list", ({ params }) => executor.schedules.list(params))
      .handle("definitions", ({ params }) =>
        executor.apps.get(params).pipe(
          Effect.flatMap((app) => callerAccounts(sql, executor, app)),
          Effect.flatMap((accounts) =>
            executor.schedules.definitions({ ...params, accounts, actor: localActor }),
          ),
        ),
      )
      // The app schedule has no actor; the SDK refuses a declaration of the other scope.
      .handle("configure", ({ params, payload: { scope, ...settings } }) =>
        executor.schedules.configure({
          ...params,
          ...settings,
          ...(scope === "app" ? {} : { actor: localActor }),
        }),
      )
      .handle("runNow", ({ params }) =>
        executor.schedules
          .copy({ ...params, actor: localActor })
          .pipe(Effect.flatMap((copy) => executor.schedules.runNow({ ...params, copy: copy.id }))),
      )
      .handle("update", ({ params, payload }) =>
        executor.schedules.update({ ...params, ...payload }),
      )
      .handle("runCopy", ({ params }) => executor.schedules.runNow(params))
      .handle("remove", ({ params }) => executor.schedules.remove(params))
      .handle("runs", ({ query }) => executor.schedules.runs(query))
      .handle("approval", ({ params }) =>
        Effect.gen(function* () {
          yield* browserOnly(config, auth);
          const pending = yield* executor.schedules.approval(params);
          const app = yield* executor.apps.get({ app: pending.run.app });
          return yield* Schema.decodeUnknownEffect(BrowserApprovalView)({
            status: "pending",
            appName: app.name,
            request: {
              status: "approval-required",
              requestId: pending.run.requestId,
              invocation: pending.invocation,
              elicitation: approvalElicitation(pending.invocation.tool, pending.invocation.input),
              expiresAt: pending.expiresAt,
            },
          }).pipe(Effect.mapError(() => new StorageError()));
        }).pipe(
          Effect.catchTag("ScheduleNotFound", () =>
            Effect.succeed({ status: "unavailable" as const }),
          ),
        ),
      )
      .handle("answer", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* browserOnly(config, auth);
          const response = yield* Schema.decodeUnknownEffect(ApprovalResponse)(
            payload.response,
          ).pipe(Effect.mapError(() => new RequestInvalid()));
          yield* executor.schedules.answer({
            ...params,
            action: response.action === "accept" ? "accept" : "decline",
          });
          return { status: "answered" as const };
        }).pipe(
          Effect.catchTag("ScheduleNotFound", () =>
            Effect.succeed({ status: "unavailable" as const }),
          ),
        ),
      ),
  );
