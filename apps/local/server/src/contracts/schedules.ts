/** Local schedule controls use paired dashboard access and have no hosted organization fields. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AccountScope,
  AppId,
  AppSchedule,
  ScheduleSettings,
  ScheduleApprovalMode,
  ScheduledRun,
  ScheduledRunId,
  ScheduleErrors,
  ScheduleId,
} from "@executor-js/sdk/core";
import {
  BrowserApprovalView,
  BrowserApprovalAcknowledgement,
  BrowserApprovalAnswer,
} from "@executor-js/mcp/browser";

const app = { app: AppId };
const copy = { ...app, name: Schema.NonEmptyString, copy: ScheduleId };
const prefix = "/dashboard/api";
/**
 * DashboardAccess is attached by the containing API to avoid a contract import cycle. User schedules
 * run as the local subject, which has one copy of each user declaration and runs it with the app's
 * linked accounts and the accounts linked to it. An app declaration has one schedule, without an
 * actor, which runs with the app's linked accounts only. Routes by name act on the local subject's
 * copy, or with `scope: "app"` on the app schedule; routes by copy act on one copy.
 */
export const DashboardSchedules = HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", `${prefix}/apps/:app/schedules`, {
      params: app,
      success: Schema.Array(ScheduleSettings),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("definitions", `${prefix}/apps/:app/schedules/definitions`, {
      params: app,
      success: Schema.Array(AppSchedule),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("configure", `${prefix}/apps/:app/schedules/:name`, {
      params: { ...app, name: Schema.NonEmptyString },
      payload: Schema.Struct({
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
        /**
         * `app` configures an app declaration's one schedule, which runs without a caller with the
         * app's linked accounts; `user`, the default, the local subject's copy of a user declaration.
         */
        scope: Schema.optional(AccountScope),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", `${prefix}/apps/:app/schedules/:name/run`, {
      params: { ...app, name: Schema.NonEmptyString },
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", `${prefix}/apps/:app/schedules/:name/copies/:copy`, {
      params: copy,
      payload: Schema.Struct({
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runCopy", `${prefix}/apps/:app/schedules/:name/copies/:copy/run`, {
      params: copy,
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${prefix}/apps/:app/schedules/:name/copies/:copy`, {
      params: copy,
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("runs", `${prefix}/scheduled-runs`, {
      query: {
        app: Schema.optional(AppId),
        pending: Schema.optional(Schema.Boolean),
      },
      success: Schema.Array(ScheduledRun),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("approval", `${prefix}/scheduled-runs/:run/approval`, {
      params: { run: ScheduledRunId },
      success: BrowserApprovalView,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("answer", `${prefix}/scheduled-runs/:run/approval`, {
      params: { run: ScheduledRunId },
      payload: BrowserApprovalAnswer,
      success: BrowserApprovalAcknowledgement,
      error: ScheduleErrors,
    }),
  );
