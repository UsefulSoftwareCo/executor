import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { ApiError } from "@executor-js/utils/api-error";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Framework data operations. Product hosts authenticate and authorize the configured app. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AppId, VersionId, Json, StorageError, CredentialsError } from "./shared.ts";
import {
  AppAccounts,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AppLinkCreatorNotAuthorized,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { VersionNotFound } from "./version.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";

/** Transportable invocation, independent of closures, credentials or server module imports. */
const AppDataInputFields = Schema.Struct({
  app: AppId,
  accounts: Schema.optional(AppAccounts),
  version: Schema.optional(VersionId),
  name: Schema.NonEmptyString,
  input: Json,
});
export const AppDataInput = AppDataInputFields.pipe(withLegacyKeys({ version: "deployment" }));
/** Parsed app query/mutation invocation. */
export type AppDataInput = typeof AppDataInput.Type;
/** The selected version did not define this operation. */
export const AppDataNotFound = ApiError.define({
  tag: "AppDataNotFound",
  status: 404,
  fields: { app: AppId, name: Schema.String },
  message: ({ name }) => `The selected version does not define the operation “${name}”.`,
  recorded: () => "The selected version does not define the requested operation",
});
export type AppDataNotFound = typeof AppDataNotFound.Type;
/** Invalid input, unavailable storage, or failed app code. Details stay in the host. */
export const AppDataFailed = ApiError.define({
  tag: "AppDataFailed",
  status: 422,
  fields: { app: AppId, name: Schema.String },
  message: ({ name }) =>
    `The operation “${name}” failed: its input was invalid, app storage was unavailable, or the app's code failed.`,
  recorded: () =>
    "The operation failed: its input was invalid, app storage was unavailable, or the app's code failed",
});
export type AppDataFailed = typeof AppDataFailed.Type;
/**
 * The operation's approval policy asked for a decision, and data calls cannot pause for one. The
 * call did not run past its policy. Run it as a tool call, which can be approved, instead.
 */
export const AppDataApprovalRequired = ApiError.define({
  tag: "AppDataApprovalRequired",
  status: 409,
  fields: { app: AppId, name: Schema.String },
  message: ({ name }) =>
    `The operation “${name}” needs approval, which a call from the app's page cannot ask for. Run it as a tool call to approve it.`,
  recorded: () => "The operation needs approval, which data calls cannot ask for",
});
export type AppDataApprovalRequired = typeof AppDataApprovalRequired.Type;

/**
 * The call named a version of an app with a database that is no longer the app's active version.
 * The database follows the active version's migrations, and the app runs one build against it at a
 * time, so a superseded build's code never runs against it. `active` is the version that serves
 * the app now, or null when none does.
 */
export const AppDataVersionSuperseded = UserFacingError.define({
  tag: "AppDataVersionSuperseded",
  status: 409,
  fields: { app: AppId, version: VersionId, active: Schema.NullOr(VersionId) },
  title: "This app version is no longer active",
  description:
    "The call named a version that a newer deploy replaced. The app's database now follows the active version, so the old version's code no longer runs against it, and a live query left on it has ended.",
  recovery: {
    action:
      "Retry the call without a version to use the active version, or reload the app page to load it.",
    instructions:
      "Send the same query or mutation again without the `version` field, or with the version in `active`, and resubscribe a live query the same way. A page reloads itself. Do not keep retrying the superseded version: it will never run again.",
  },
});
export type AppDataVersionSuperseded = typeof AppDataVersionSuperseded.Type;

/**
 * Each data failure on its own, for endpoint error lists: a union keeps their bodies but loses each
 * one's HTTP status, so every failure would answer 500.
 */
export const appDataErrors = [
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  VersionNotFound,
  AccountRequired,
  AppLinkCreatorNotAuthorized,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  AppDataNotFound,
  AppDataFailed,
  AppDataApprovalRequired,
  AppDataVersionSuperseded,
] as const;
/** Data failures shared by transports without losing their precise typed union. */
export const AppDataErrors = Schema.Union(appDataErrors);

/** Full current query result; revisions belong to the current server process. */
export const AppDataSnapshot = Schema.Struct({ revision: Schema.Int, value: Json });
/** JSON operation endpoints; subscriptions are composed by the serving host. */
export const AppDataGroup = HttpApiGroup.make("appData")
  .add(
    HttpApiEndpoint.post("subscribe", "/v1/app-data/subscribe", {
      payload: AppDataInput,
      success: HttpApiSchema.StreamSse({ data: AppDataSnapshot, error: AppDataErrors }),
    }),
  )
  .add(
    HttpApiEndpoint.post("query", "/v1/app-data/query", {
      payload: AppDataInput,
      success: Json,
      error: appDataErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/v1/app-data/mutate", {
      payload: AppDataInput,
      success: Json,
      error: appDataErrors,
    }),
  );
