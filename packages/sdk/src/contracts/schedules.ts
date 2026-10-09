import { ProfileId } from "./shared.ts";
import { ApiError } from "@executor-js/utils/api-error";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** Installed schedule controls and run review; timing and arguments remain authored app source. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { OperationSchedule, ScheduleTiming } from "apps/contracts";
import {
  AppId,
  OwnerId,
  ApprovalRequestId,
  StorageError,
  RequestInvalid,
  ToolName,
} from "./shared.ts";
import { AppNotDeployed, AppNotFound, AccountRequired, AccountSelectionInvalid } from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { AccountId } from "./shared.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";
import { CredentialsError } from "./shared.ts";
import { AppProviderFailed, AppEvaluationFailed, ToolInvocation } from "./tools.ts";

/** Stable configured schedule address, independent of deployment revisions. */
export const ScheduleId = Schema.NonEmptyString.pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;
/** One scheduled occurrence or explicit run-now attempt. */
export const ScheduledRunId = Schema.NonEmptyString.pipe(Schema.brand("ScheduledRunId"));
export type ScheduledRunId = typeof ScheduledRunId.Type;
/** Browser review is opt-in. Automatic accepts approval requests, never explicit denials. */
export const ScheduleApprovalMode = Schema.Literals(["automatic", "browser"]);
/** Safe outcomes contain no tool results, credentials or arbitrary exception messages. */
export const ScheduledRunStatus = Schema.Literals([
  "running",
  "awaiting-approval",
  "ready",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "interrupted",
]);
/** Installation state is independent of an authored schedule's current definition. */
export const ScheduleSettings = Schema.Struct({
  id: ScheduleId,
  app: AppId,
  profile: Schema.NullOr(ProfileId),
  owner: OwnerId,
  name: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  approvalMode: ScheduleApprovalMode,
  timing: ScheduleTiming,
  nextAt: Schema.NullOr(Schema.Date),
  activeRun: Schema.NullOr(ScheduledRunId),
  revision: Schema.String,
  /**
   * Read-only state, never stored: an account this profile selects must reconnect before the
   * schedule can run. Its occurrences are skipped without running until the account reconnects,
   * then the schedule resumes on its own.
   */
  reconnectAccount: Schema.optionalKey(AccountId),
}).check(Schema.makeFilter((value) => !value.enabled || value.nextAt !== null));
export type ScheduleSettings = typeof ScheduleSettings.Type;
/** Discovery remains account-dependent; a missing settings row means paused. */
export const AppSchedule = Schema.Struct({
  ...OperationSchedule.fields,
  app: AppId,
  profile: Schema.optional(ProfileId),
  tool: ToolName,
  settings: Schema.NullOr(ScheduleSettings),
});
export type AppSchedule = typeof AppSchedule.Type;
/** Run metadata can be shown without decrypting a pending approval's arguments. */
export const ScheduledRun = Schema.Struct({
  id: ScheduledRunId,
  scheduleId: ScheduleId,
  app: AppId,
  profile: Schema.NullOr(ProfileId),
  owner: OwnerId,
  name: Schema.String,
  status: ScheduledRunStatus,
  scheduledAt: Schema.Date,
  startedAt: Schema.Date,
  finishedAt: Schema.NullOr(Schema.Date),
  requestId: Schema.NullOr(ApprovalRequestId),
  expiresAt: Schema.NullOr(Schema.Date),
  failure: Schema.NullOr(Schema.String),
});
export type ScheduledRun = typeof ScheduledRun.Type;
/** Pending reviews reuse the SDK's exact saved invocation and expiration. */
export const ScheduledApproval = Schema.Struct({
  run: ScheduledRun,
  invocation: ToolInvocation,
  expiresAt: Schema.Number,
});
/** Persisted transition state; only the runner dispatches recorded answers. */
export const StoredScheduledRun = Schema.Struct({
  ...ScheduledRun.fields,
  runner: Schema.String,
  revision: Schema.String,
  answer: Schema.NullOr(Schema.Literals(["accept", "decline"])),
}).check(
  Schema.makeFilter((value) =>
    value.status === "ready"
      ? value.requestId !== null && value.expiresAt !== null && value.answer !== null
      : value.status !== "awaiting-approval" ||
        (value.requestId !== null && value.expiresAt !== null),
  ),
);
export type StoredScheduledRun = typeof StoredScheduledRun.Type;
/** A schedule is absent from the live app definition, or its saved row is inaccessible. */
export const ScheduleNotFound = ApiError.define({
  tag: "ScheduleNotFound",
  status: 404,
  message:
    "The app's current deployment does not declare this schedule, or the schedule run is not waiting for approval.",
});
export type ScheduleNotFound = typeof ScheduleNotFound.Type;
/** A competing run or reviewer has already advanced this schedule. */
export const ScheduleConflict = ApiError.define({
  tag: "ScheduleConflict",
  status: 409,
  message:
    "The schedule changed or is already running, or its profile changed. Read the schedule again before retrying.",
});
export type ScheduleConflict = typeof ScheduleConflict.Type;
/** Calendar timing could not produce a valid future occurrence. */
export const ScheduleInvalid = ApiError.define({
  tag: "ScheduleInvalid",
  status: 400,
  message: "The schedule's timing does not produce a valid future occurrence.",
});
export type ScheduleInvalid = typeof ScheduleInvalid.Type;

const app = {
  app: AppId,
  profile: Schema.optional(ProfileId),
  owner: Schema.optional(OwnerId),
};
const run = { run: ScheduledRunId, owner: Schema.optional(OwnerId) };
/** Runtime identity is supplied by the serving host; owner filters alone do not authorize changes. */
export const ScheduleInputs = {
  list: Schema.Struct(app),
  definitions: Schema.Struct(app),
  configure: Schema.Struct({
    ...app,
    name: Schema.NonEmptyString,
    actor: Schema.NonEmptyString,
    expectedProfileRevision: Schema.optional(ProfileRevision),
    enabled: Schema.Boolean,
    approvalMode: Schema.optional(ScheduleApprovalMode),
  }),
  runNow: Schema.Struct({ ...app, name: Schema.NonEmptyString }),
  runs: Schema.Struct({
    owner: Schema.optional(OwnerId),
    app: Schema.optional(AppId),
    profile: Schema.optional(ProfileId),
    pending: Schema.optional(Schema.Boolean),
  }),
  approval: Schema.Struct(run),
  answer: Schema.Struct({ ...run, action: Schema.Literals(["accept", "decline"]) }),
};
/** Live discovery preserves existing account and source failures rather than returning an empty catalog. */
export const ScheduleErrors = [
  ...ProfileErrors,
  StorageError,
  RequestInvalid,
  ScheduleNotFound,
  ScheduleConflict,
  ScheduleInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AccountSelectionInvalid,
  AccountNotFound,
  DeploymentNotFound,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  CredentialsError,
  AppEvaluationFailed,
  AppProviderFailed,
] as const;
/** Local SDK serving routes. Hosted products wrap these operations in their own authority. */
export const SchedulesGroup = HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/schedules", {
      params: { app: AppId },
      query: { owner: Schema.optional(OwnerId), profile: Schema.optional(ProfileId) },
      success: Schema.Array(ScheduleSettings),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("definitions", "/v1/apps/:app/schedules/definitions", {
      params: { app: AppId },
      query: { owner: Schema.optional(OwnerId), profile: Schema.optional(ProfileId) },
      success: Schema.Array(AppSchedule),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("configure", "/v1/apps/:app/schedules/:name", {
      params: { app: AppId, name: Schema.NonEmptyString },
      payload: Schema.Struct({
        owner: Schema.optional(OwnerId),
        actor: Schema.NonEmptyString,
        expectedProfileRevision: Schema.optional(ProfileRevision),
        profile: Schema.optional(ProfileId),
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", "/v1/apps/:app/schedules/:name/run", {
      params: { app: AppId, name: Schema.NonEmptyString },
      payload: Schema.Struct({
        owner: Schema.optional(OwnerId),
        profile: Schema.optional(ProfileId),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("runs", "/v1/scheduled-runs", {
      query: ScheduleInputs.runs.fields,
      success: Schema.Array(ScheduledRun),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("approval", "/v1/scheduled-runs/:run/approval", {
      params: { run: ScheduledRunId },
      query: { owner: Schema.optional(OwnerId) },
      success: ScheduledApproval,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("answer", "/v1/scheduled-runs/:run/approval", {
      params: { run: ScheduledRunId },
      payload: Schema.Struct({
        owner: Schema.optional(OwnerId),
        action: Schema.Literals(["accept", "decline"]),
      }),
      success: ScheduledRun,
      error: ScheduleErrors,
    }),
  );
