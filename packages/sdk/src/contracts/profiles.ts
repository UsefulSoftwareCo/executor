import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Durable account bindings and setup state for one use of an app. Deployments belong to the app. */
import { Context, Schema, type Effect } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { AppId, OwnerId, ProfileId, DeploymentId, StorageError } from "./shared.ts";
import { AppNotFound, AccountSelectionInvalid, SelectedAccounts } from "./apps.ts";
import { AccountNotFound } from "./account.ts";

/** A revision protects account choices and durable setup against concurrent updates. */
export const ProfileRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** Setup input is app-owned configuration, not provider credentials. */
export const ProfileWebhookConfig = Schema.Record(Schema.NonEmptyString, Schema.Json);
/** A profile never selects its own code version or owns a separate database. */
export const Profile = Schema.Struct({
  id: ProfileId,
  app: AppId,
  owner: OwnerId,
  subject: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
  accounts: SelectedAccounts,
  webhookConfig: ProfileWebhookConfig,
  revision: ProfileRevision,
  enabled: Schema.Boolean,
  status: Schema.Literals([
    "pending",
    "ready",
    "needs-setup",
    "failed",
    "disabled",
    "removing",
    "removed",
  ]),
  failure: Schema.NullOr(
    Schema.Literals([
      "accounts",
      "configuration",
      "registration",
      "cleanup",
      "access",
      "deployment",
    ]),
  ),
  reconciledDeployment: Schema.NullOr(DeploymentId),
  reconciledRevision: Schema.NullOr(ProfileRevision),
  createdAt: Schema.Date,
});
export type Profile = typeof Profile.Type;

/** Trusted invocation metadata for product credential policy; never supplied by authored code. */
export const CurrentProfile = Context.Reference<Profile | undefined>("executor/CurrentProfile", {
  defaultValue: () => undefined,
});
/** Profiles are always resolved within the requested app and optional owner. */
export const ProfileNotFound = UserFacingError.define({
  tag: "ProfileNotFound",
  status: 404,
  fields: { app: AppId, profile: ProfileId },
  title: "Account selection unavailable",
  description: "The saved account selection for this app could not be found.",
  recovery: {
    action: "Open the app’s Accounts tab and choose an available profile.",
    instructions:
      "Read the current app’s account requirements and saved account selection. Reopen setup to establish the intended selection through the supported account flow. Do not invent missing bindings or reuse a stale profile reference.",
  },
});
/** Parsed ProfileNotFound failure. */
export type ProfileNotFound = typeof ProfileNotFound.Type;
/** A stale editor or stopped profile cannot silently select another identity. */
export const ProfileConflict = UserFacingError.define({
  tag: "ProfileConflict",
  status: 409,
  fields: {
    profile: ProfileId,
    reason: Schema.Literals(["revision", "idempotency", "inactive", "active-resources"]),
  },
  title: "Account selection needs attention",
  description: "The saved account selection changed or is not available for this action.",
  recovery: {
    action: "Reload the current account selection and review it before making changes.",
    instructions:
      "Read the latest profile state, account requirements, and active resource bindings. Resolve the conflict against the user’s intended selection. Preserve newer selections and active resource bindings; do not overwrite them with stale state.",
  },
});
/** Parsed ProfileConflict failure. */
export type ProfileConflict = typeof ProfileConflict.Type;
/** Shared errors preserve profile failures through execution transports. */
export const ProfileErrors = [ProfileNotFound, ProfileConflict] as const;
const target = { app: AppId, profile: ProfileId };
export const ProfileInputs = {
  create: Schema.Struct({
    app: AppId,
    owner: OwnerId,
    subject: Schema.NonEmptyString,
    name: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
    accounts: SelectedAccounts,
    webhookConfig: Schema.optional(ProfileWebhookConfig),
    idempotencyKey: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  }),
  get: Schema.Struct({ ...target, owner: Schema.optional(OwnerId) }),
  list: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    subject: Schema.optional(Schema.NonEmptyString),
  }),
  /** List existing profiles across explicit apps; absent apps contribute no rows. */
  listMany: Schema.Struct({
    apps: Schema.Array(AppId),
    owner: OwnerId,
    subject: Schema.NonEmptyString,
  }),
  update: Schema.Struct({
    ...target,
    expectedRevision: ProfileRevision,
    accounts: SelectedAccounts,
    webhookConfig: Schema.optional(ProfileWebhookConfig),
  }),
  setEnabled: Schema.Struct({
    ...target,
    expectedRevision: ProfileRevision,
    enabled: Schema.Boolean,
  }),
  reconcile: Schema.Struct(target),
  remove: Schema.Struct(target),
};
const errors = [
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  ...ProfileErrors,
] as const;
/** App setup uses the same native contract in SDK and HTTP clients. */
export const AppProfilesGroup = HttpApiGroup.make("appProfiles")
  .add(
    HttpApiEndpoint.post("create", "/v1/apps/:app/profiles", {
      params: { app: AppId },
      payload: ProfileInputs.create.mapFields(({ app: _app, ...fields }) => fields),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/apps/:app/profiles/:profile", {
      params: target,
      query: { owner: Schema.optional(OwnerId) },
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/profiles", {
      params: { app: AppId },
      query: { owner: Schema.optional(OwnerId), subject: Schema.optional(Schema.NonEmptyString) },
      success: Schema.Array(Profile),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("listMany", "/v1/profiles/list", {
      payload: ProfileInputs.listMany,
      success: Schema.Array(Profile),
      error: [StorageError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/apps/:app/profiles/:profile", {
      params: target,
      payload: Schema.Struct({
        expectedRevision: ProfileRevision,
        accounts: SelectedAccounts,
        webhookConfig: Schema.optional(ProfileWebhookConfig),
      }),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("setEnabled", "/v1/apps/:app/profiles/:profile/enabled", {
      params: target,
      payload: Schema.Struct({ expectedRevision: ProfileRevision, enabled: Schema.Boolean }),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcile", "/v1/apps/:app/profiles/:profile/reconcile", {
      params: target,
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/apps/:app/profiles/:profile", {
      params: target,
      success: Profile,
      error: errors,
    }),
  );

/** Host-owned durable setup wake; never an app-authored capability. */
export const ProfileHost = Symbol.for("executor/ProfileHost");
export interface ProfileDispatcher {
  readonly tick: (limit: number) => Effect.Effect<void, StorageError>;
}
