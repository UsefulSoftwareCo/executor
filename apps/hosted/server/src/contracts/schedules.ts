/** Organization-aware schedule management, with browser-only human review. */
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AppId,
  ProfileId,
  AppSchedule,
  ScheduleSettings,
  ScheduleApprovalMode,
  ScheduledRun,
  ScheduledRunId,
  ScheduleErrors,
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
import { Forbidden } from "./auth.ts";

/** Each host supplies current membership/account checks and any execution admission policy. */
export class ScheduledAuthority extends Context.Service<
  ScheduledAuthority,
  (target: ScheduleAuthority) => Effect.Effect<void, Error>
>()("hosted/ScheduledAuthority") {}
/** Node polling supplies a no-op; Cloudflare binds an immediate durable coordinator wake. */
export const ScheduleWakeup = Context.Reference<Effect.Effect<void>>("hosted/ScheduleWakeup", {
  defaultValue: () => Effect.void,
});
const organization = { organization: OrganizationReference };
const app = { ...organization, app: AppId };
const prefix = "/api/organizations/:organization";
const errors = [...ScheduleErrors, OrganizationForbidden, Forbidden] as const;
/** App source owns timing/arguments. These routes only control the installed schedule and review runs. */
export const HostedSchedules = HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", `${prefix}/apps/:app/schedules`, {
      params: app,
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(ScheduleSettings),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("definitions", `${prefix}/apps/:app/schedules/definitions`, {
      params: app,
      query: { profile: Schema.optional(ProfileId) },
      success: Schema.Array(AppSchedule),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("configure", `${prefix}/apps/:app/schedules/:name`, {
      params: { ...app, name: Schema.NonEmptyString },
      payload: Schema.Struct({
        profile: Schema.optional(ProfileId),
        enabled: Schema.Boolean,
        approvalMode: Schema.optional(ScheduleApprovalMode),
      }),
      success: ScheduleSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("runNow", `${prefix}/apps/:app/schedules/:name/run`, {
      params: { ...app, name: Schema.NonEmptyString },
      query: { profile: Schema.optional(ProfileId) },
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
        profile: Schema.optional(ProfileId),
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
    }),
  )
  .add(
    HttpApiEndpoint.post("answer", `${prefix}/scheduled-runs/:run/approval`, {
      params: { ...organization, run: ScheduledRunId },
      payload: BrowserApprovalAnswer,
      success: BrowserApprovalAcknowledgement,
      error: errors,
    }),
  )
  .middleware(RequireOrganization);
