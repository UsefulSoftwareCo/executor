import { ApiError } from "@executor-js/utils/api-error";
/** Schedule controls and run review; timing and arguments remain authored app source. */
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
import {
  AppAccounts,
  AppAccountsQuery,
  AppNotDeployed,
  AppNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { AccountId } from "./shared.ts";
import { VersionNotFound } from "./version.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";
import { CredentialsError } from "./shared.ts";
import { AppProviderFailed, AppEvaluationFailed, ToolInvocation } from "./tools.ts";

/**
 * Storage cannot hold NUL, so a name or ID that carries one reaches a lookup that fails, which
 * surfaces as a storage error to retry. Refuse it as a bad request instead. Only NUL: every other
 * character is a name or ID that is merely not found, and an app may declare it.
 */
// oxlint-disable-next-line no-control-regex -- NUL is refused on purpose
const withoutNul = Schema.isPattern(/^[^\u0000]*$/u);
/** A schedule's name, as an app declares it, in a route. */
export const ScheduleName = Schema.NonEmptyString.check(withoutNul);
/** The subject a request names the copy of; a saved copy's `actor` is read back as it was stored. */
const ActorInput = Schema.NonEmptyString.check(withoutNul);
/** Stable configured schedule address, independent of app versions. */
export const ScheduleId = Schema.NonEmptyString.check(withoutNul).pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;
/** One scheduled occurrence or explicit run-now attempt. */
export const ScheduledRunId = Schema.NonEmptyString.check(withoutNul).pipe(
  Schema.brand("ScheduledRunId"),
);
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
/**
 * Saved state for one member's copy of a declared user schedule, or for an app schedule,
 * independent of its current definition. A member has at most one copy of each user declaration;
 * each run is checked against the copy's actor and runs with the app's linked accounts and the
 * actor's linked accounts: the one of each plain requirement and every one of a many()
 * requirement. An app declaration has one schedule, without an actor, which runs without a
 * caller with the app's accounts only.
 */
export const ScheduleSettings = Schema.Struct({
  id: ScheduleId,
  app: AppId,
  owner: OwnerId,
  name: Schema.NonEmptyString,
  /** The subject the copy belongs to, whose access each run is checked against; null for an app schedule. */
  actor: Schema.NullOr(Schema.NonEmptyString),
  enabled: Schema.Boolean,
  approvalMode: ScheduleApprovalMode,
  timing: ScheduleTiming,
  nextAt: Schema.NullOr(Schema.Date),
  activeRun: Schema.NullOr(ScheduledRunId),
  revision: Schema.String,
  /**
   * Read-only state, never stored: an account the schedule resolves must reconnect before it can
   * run. Its occurrences are skipped without running until the account reconnects, then the
   * schedule resumes on its own.
   */
  reconnectAccount: Schema.optionalKey(AccountId),
  /**
   * Read-only state, never stored: the actor has no account linked for this plain requirement.
   * Occurrences are skipped until they link one.
   */
  accountRequired: Schema.optionalKey(Schema.NonEmptyString),
}).check(Schema.makeFilter((value) => !value.enabled || value.nextAt !== null));
export type ScheduleSettings = typeof ScheduleSettings.Type;
/** Discovery remains account-dependent; a missing settings row means paused. */
export const AppSchedule = Schema.Struct({
  ...OperationSchedule.fields,
  app: AppId,
  tool: ToolName,
  settings: Schema.NullOr(ScheduleSettings),
});
export type AppSchedule = typeof AppSchedule.Type;
/** Run metadata can be shown without decrypting a pending approval's arguments. */
export const ScheduledRun = Schema.Struct({
  id: ScheduledRunId,
  scheduleId: ScheduleId,
  app: AppId,
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
    "The app's current version does not declare this schedule, or the schedule run is not waiting for approval.",
});
export type ScheduleNotFound = typeof ScheduleNotFound.Type;
/** A competing run or reviewer has already advanced this schedule. */
export const ScheduleConflict = ApiError.define({
  tag: "ScheduleConflict",
  status: 409,
  message: "The schedule changed or is already running. Read the schedule again before retrying.",
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
  owner: Schema.optional(OwnerId),
};
const run = { run: ScheduledRunId, owner: Schema.optional(OwnerId) };
/** One copy, under its declaration. A copy of another declaration is not found. */
const copy = { ...app, name: ScheduleName, copy: ScheduleId };
/** The actor's copy of a user declaration, or without an actor an app declaration's schedule. */
const own = { ...app, name: ScheduleName, actor: Schema.optional(ActorInput) };
/** Runtime identity is supplied by the serving host; owner filters alone do not authorize changes. */
export const ScheduleInputs = {
  list: Schema.Struct(app),
  /**
   * Declarations evaluated with the named accounts, which the product resolved from the caller's
   * links. Each carries `actor`'s copy, or null without one.
   */
  definitions: Schema.Struct({
    ...app,
    accounts: Schema.optional(AppAccounts),
    actor: Schema.optional(ActorInput),
  }),
  /**
   * Configure the actor's copy, adding it when they have none; without an actor, the app
   * declaration's one schedule. Enabling evaluates the app with the accounts its runs use and
   * checks the declaration has that scope.
   */
  configure: Schema.Struct({
    ...own,
    enabled: Schema.Boolean,
    approvalMode: Schema.optional(ScheduleApprovalMode),
  }),
  /** The actor's copy; `ScheduleNotFound` when they have none. */
  copy: Schema.Struct(own),
  /** Pause or resume one copy, or change its approvals. Its actor never changes. */
  update: Schema.Struct({
    ...copy,
    enabled: Schema.Boolean,
    approvalMode: Schema.optional(ScheduleApprovalMode),
  }),
  runNow: Schema.Struct(copy),
  /**
   * Remove one copy and its run history. A waiting approval is withdrawn; a running mutation
   * finishes, then its record is removed.
   */
  remove: Schema.Struct(copy),
  runs: Schema.Struct({
    owner: Schema.optional(OwnerId),
    app: Schema.optional(AppId),
    pending: Schema.optional(Schema.Boolean),
  }),
  approval: Schema.Struct(run),
  answer: Schema.Struct({ ...run, action: Schema.Literals(["accept", "decline"]) }),
};
/** Live discovery preserves existing account and source failures rather than returning an empty catalog. */
export const ScheduleErrors = [
  StorageError,
  RequestInvalid,
  ScheduleNotFound,
  ScheduleConflict,
  ScheduleInvalid,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  AccountNotFound,
  VersionNotFound,
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
      query: { owner: Schema.optional(OwnerId) },
      success: Schema.Array(ScheduleSettings),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("definitions", "/v1/apps/:app/schedules/definitions", {
      params: { app: AppId },
      query: {
        owner: Schema.optional(OwnerId),
        accounts: AppAccountsQuery,
        actor: Schema.optional(ActorInput),
      },
      success: Schema.Array(AppSchedule),
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("configure", "/v1/apps/:app/schedules/:name", {
      params: { app: AppId, name: ScheduleName },
      payload: Schema.Struct({
        owner: Schema.optional(OwnerId),
        actor: Schema.optional(ActorInput),
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("copy", "/v1/apps/:app/schedules/:name/copy", {
      params: { app: AppId, name: ScheduleName },
      query: {
        owner: Schema.optional(OwnerId),
        actor: Schema.optional(ActorInput),
      },
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/apps/:app/schedules/:name/copies/:copy", {
      params: { app: AppId, name: ScheduleName, copy: ScheduleId },
      payload: Schema.Struct({
        owner: Schema.optional(OwnerId),
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
      }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", "/v1/apps/:app/schedules/:name/copies/:copy/run", {
      params: { app: AppId, name: ScheduleName, copy: ScheduleId },
      payload: Schema.Struct({ owner: Schema.optional(OwnerId) }),
      success: ScheduleSettings,
      error: ScheduleErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/apps/:app/schedules/:name/copies/:copy", {
      params: { app: AppId, name: ScheduleName, copy: ScheduleId },
      query: { owner: Schema.optional(OwnerId) },
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
