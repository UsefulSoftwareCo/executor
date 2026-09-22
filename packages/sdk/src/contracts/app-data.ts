import { ProfileId } from "./shared.ts";
import { ProfileErrors, ProfileRevision } from "./profiles.ts";
/** Framework data operations. Product hosts authenticate and authorize the configured app. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { AppId, DeploymentId, Json, StorageError, CredentialsError } from "./shared.ts";
import { AppNotFound, AppNotDeployed, AccountRequired, AccountSelectionInvalid } from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import { DeploymentNotFound } from "./deployment.ts";
import { OAuthReconnectRequired } from "./oauth.ts";

/** Transportable invocation, independent of closures, credentials or server module imports. */
export const AppDataInput = Schema.Struct({
  app: AppId,
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  deployment: Schema.optional(DeploymentId),
  name: Schema.NonEmptyString,
  input: Json,
});
/** Parsed app query/mutation invocation. */
export type AppDataInput = typeof AppDataInput.Type;
/** The selected deployment did not define this operation. */
export class AppDataNotFound extends Schema.TaggedError<AppDataNotFound>()(
  "AppDataNotFound",
  {
    app: AppId,
    name: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
/** Invalid input, unavailable storage, or failed app code. Details stay in the host. */
export class AppDataFailed extends Schema.TaggedError<AppDataFailed>()(
  "AppDataFailed",
  {
    app: AppId,
    name: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

const errors = [
  ...ProfileErrors,
  StorageError,
  CredentialsError,
  AppNotFound,
  AppNotDeployed,
  AccountNotFound,
  DeploymentNotFound,
  AccountRequired,
  AccountSelectionInvalid,
  OAuthReconnectRequired,
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
