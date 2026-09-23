/** Product-owned browser review; scheduler actions otherwise share the normal local SDK. */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { StorageError, RequestInvalid, type Executor } from "@executor-js/sdk/core";
import { ApprovalResponse, approvalElicitation } from "apps/contracts";
import { BrowserApprovalView } from "@executor-js/mcp/browser";
import { DashboardApi, DashboardForbidden, DashboardUnauthorized } from "../contracts/dashboard.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";

/** Authentication is shared with dashboard routes; human decisions additionally require a browser cookie. */
export const localScheduleHandlers = (
  executor: Executor,
  config: ServerConfig,
  auth: LocalAuth,
) => {
  const browserOnly = Effect.gen(function* () {
    const request = yield* localRequest(config.port, config.browserOrigin).pipe(
      Effect.mapError(() => new DashboardForbidden()),
    );
    if (
      request.headers.authorization !== undefined ||
      (request.method === "POST" && request.headers.origin !== requestOrigin(config, request))
    )
      return yield* new DashboardForbidden();
    if (!(yield* auth.valid(request.cookies[sessionCookie(config.port)])))
      return yield* new DashboardUnauthorized();
  });
  return HttpApiBuilder.group(DashboardApi, "schedules", (handlers) =>
    handlers
      .handle("list", ({ params, query }) => executor.schedules.list({ ...params, ...query }))
      .handle("definitions", ({ params, query }) =>
        executor.schedules.definitions({ ...params, ...query }),
      )
      .handle("configure", ({ params, payload }) =>
        executor.schedules.configure({ ...params, ...payload, actor: "local" }),
      )
      .handle("runNow", ({ params, query }) => executor.schedules.runNow({ ...params, ...query }))
      .handle("runs", ({ query }) => executor.schedules.runs(query))
      .handle("approval", ({ params }) =>
        Effect.gen(function* () {
          yield* browserOnly;
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
          yield* browserOnly;
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
};
