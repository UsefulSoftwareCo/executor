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
  ScheduleName,
} from "@executor-js/sdk/core";
import {
  BrowserApprovalView,
  BrowserApprovalAcknowledgement,
  BrowserApprovalAnswer,
} from "@executor-js/mcp/browser";

const app = { app: AppId };
const copy = { ...app, name: ScheduleName, copy: ScheduleId };
const prefix = "/dashboard/api";
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
      params: { ...app, name: ScheduleName },
      payload: Schema.Struct({
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
        scope: Schema.optional(AccountScope),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", `${prefix}/apps/:app/schedules/:name/run`, {
      params: { ...app, name: ScheduleName },
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
