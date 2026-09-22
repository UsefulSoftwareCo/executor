/** Paired local setup has one local subject and no organization roles. */
import {
  AppId,
  WebhookSubscription,
  WebhookErrors,
  ProfileId,
  Profile,
  ProfileInputs,
  ProfileErrors,
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
const app = { app: AppId };
const target = { ...app, profile: ProfileId };
const path = "/dashboard/api/apps/:app/profiles";
const errors = [
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  ...ProfileErrors,
] as const;
/** Setup writes need app use, never permission to change source or another person's setup. */
export const DashboardProfiles = HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("webhooks", `${path}/:profile/webhooks`, {
      params: target,
      success: Schema.Array(WebhookSubscription),
      error: WebhookErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", path, {
      params: app,
      success: Schema.Array(Profile),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", `${path}/:profile`, {
      params: target,
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: app,
      payload: ProfileInputs.create.mapFields(
        ({ app: _app, owner: _owner, subject: _subject, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", `${path}/:profile`, {
      params: target,
      payload: ProfileInputs.update.mapFields(
        ({ app: _app, profile: _profile, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("setEnabled", `${path}/:profile/enabled`, {
      params: target,
      payload: ProfileInputs.setEnabled.mapFields(
        ({ app: _app, profile: _profile, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcile", `${path}/:profile/reconcile`, {
      params: target,
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${path}/:profile`, {
      params: target,
      success: Profile,
      error: errors,
    }),
  );
