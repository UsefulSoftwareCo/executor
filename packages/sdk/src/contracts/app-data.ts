import { ApiError } from "@executor-js/utils/api-error";
/** Framework data operations. Product hosts authenticate and authorize the configured app. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { AppId, DeploymentId, Json, StorageError, CredentialsError } from "./shared.ts";
import {
  AppAccounts,
  AppNotFound,
  AppNotDeployed,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
} from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired, OAuthRenewalFailed } from "./oauth.ts";

/** Transportable invocation, independent of closures, credentials or server module imports. */
export const AppDataInput = Schema.Struct({
  app: AppId,
  accounts: Schema.optional(AppAccounts),
  deployment: Schema.optional(DeploymentId),
  name: Schema.NonEmptyString,
  input: Json,
});
/** Parsed app query/mutation invocation. */
export type AppDataInput = typeof AppDataInput.Type;
/** The selected deployment did not define this operation. */
export const AppDataNotFound = ApiError.define({
  tag: "AppDataNotFound",
  status: 404,
  fields: { app: AppId, name: Schema.String },
  message: ({ name }) => `The selected deployment does not define the operation “${name}”.`,
  recorded: () => "The selected deployment does not define the requested operation",
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

const errors = [
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  DeploymentNotFound,
  AccountRequired,
  AccountChoiceUnsupported,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
  OAuthRenewalFailed,
  AppDataNotFound,
  AppDataFailed,
] as const;
/** Data failures shared by transports without losing their precise typed union. */
export const AppDataErrors = Schema.Union(errors);

/** Full current query result; revisions belong to the current server process. */
export const AppDataSnapshot = Schema.Struct({ revision: Schema.Int, value: Json });
/** JSON operation endpoints; subscriptions are composed by the serving host. */
export const AppDataGroup = HttpApiGroup.make("appData")
  .add(
    HttpApiEndpoint.post("subscribe", "/v1/app-data/subscribe", {
      payload: AppDataInput,
      success: HttpApiSchema.StreamSse({ data: AppDataSnapshot, error: Schema.Union(errors) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("query", "/v1/app-data/query", {
      payload: AppDataInput,
      success: Json,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/v1/app-data/mutate", {
      payload: AppDataInput,
      success: Json,
      error: errors,
    }),
  );
