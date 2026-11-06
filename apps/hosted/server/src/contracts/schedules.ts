/** Organization-aware schedule management, with browser-only human review. */
import { Context, Effect, Schema } from "effect";
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
  type ScheduleAuthority,
} from "@executor-js/sdk/core";
import {
  BrowserApprovalView,
  BrowserApprovalAcknowledgement,
  BrowserApprovalAnswer,
} from "@executor-js/mcp/browser";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { BrowserSessionOnly, Forbidden } from "./auth.ts";

/** Each host supplies current membership/account checks and any execution admission policy. */
export class ScheduledAuthority extends Context.Service<
  ScheduledAuthority,
  (target: ScheduleAuthority) => Effect.Effect<void, Error>
>()("hosted/ScheduledAuthority") {}
/**
 * Wakes pending setup after a write that leaves it to do, such as a deploy or an account link.
 * Periodic polling remains the recovery path. There is no default: every route and background job
 * that writes supplies its host's wake, or `Effect.void` where the next poll is the intended path.
 */
export class ScheduleWakeup extends Context.Service<ScheduleWakeup, Effect.Effect<void>>()(
  "hosted/ScheduleWakeup",
) {}
const organization = { organization: OrganizationReference };
const app = { ...organization, app: AppId };
const copy = { ...app, name: ScheduleName, copy: ScheduleId };
const prefix = "/api/organizations/:organization";
const errors = [...ScheduleErrors, OrganizationForbidden, Forbidden] as const;
/**
 * App source owns timing/arguments. These routes only control schedule copies and review runs.
 * Each member has at most one copy of a user declaration, which runs as that member with the app's
 * linked accounts and the accounts they linked to it. An app declaration has one schedule, without
 * an actor, which runs with the app's linked accounts and which only the app's managers control.
 * Routes by name act on the caller's own copy, or with `scope: "app"` on the app schedule; routes
 * by copy act on one copy, which its member, or someone who manages the app, controls.
 */
export const HostedSchedules = HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", `${prefix}/apps/:app/schedules`, {
      params: app,
      success: Schema.Array(ScheduleSettings),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("definitions", `${prefix}/apps/:app/schedules/definitions`, {
      params: app,
      success: Schema.Array(AppSchedule),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("configure", `${prefix}/apps/:app/schedules/:name`, {
      params: { ...app, name: ScheduleName },
      payload: Schema.Struct({
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
        /**
         * `app` configures an app declaration's one schedule, which runs without a caller with
         * the app's linked accounts and only its managers control; `user`, the default, the
         * caller's own copy of a user declaration.
         */
        scope: Schema.optional(AccountScope),
      }),
      success: ScheduleSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", `${prefix}/apps/:app/schedules/:name/run`, {
      params: { ...app, name: ScheduleName },
      success: ScheduleSettings,
      error: errors,
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
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runCopy", `${prefix}/apps/:app/schedules/:name/copies/:copy/run`, {
      params: copy,
      success: ScheduleSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${prefix}/apps/:app/schedules/:name/copies/:copy`, {
      params: copy,
      success: ScheduleSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("runs", `${prefix}/scheduled-runs`, {
      params: organization,
      query: {
        app: Schema.optional(AppId),
        pending: Schema.optional(Schema.Boolean),
      },
      success: Schema.Array(ScheduledRun),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("approval", `${prefix}/scheduled-runs/:run/approval`, {
      params: { ...organization, run: ScheduledRunId },
      success: BrowserApprovalView,
      error: errors,
    }).annotate(BrowserSessionOnly, true),
  )
  .add(
    HttpApiEndpoint.post("answer", `${prefix}/scheduled-runs/:run/approval`, {
      params: { ...organization, run: ScheduledRunId },
      payload: BrowserApprovalAnswer,
      success: BrowserApprovalAcknowledgement,
      error: errors,
    }).annotate(BrowserSessionOnly, true),
  )
  .middleware(RequireOrganization);
