/** Personal app setup. The host derives owner and subject from authenticated membership. */
import {
  AppId,
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
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { RequiredAction } from "./authorization.ts";
const app = { organization: OrganizationReference, app: AppId };
const target = { ...app, profile: ProfileId };
const path = "/api/organizations/:organization/apps/:app/profiles";
const errors = [
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  OrganizationForbidden,
  ...ProfileErrors,
] as const;
/** Setup writes need app use, never permission to change source or another person's setup. */
export const HostedProfiles = HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: app,
      success: Schema.Array(Profile),
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("get", `${path}/:profile`, {
      params: target,
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: app,
      payload: ProfileInputs.create.mapFields(
        ({ app: _app, owner: _owner, subject: _subject, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.patch("update", `${path}/:profile`, {
      params: target,
      payload: ProfileInputs.update.mapFields(
        ({ app: _app, profile: _profile, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.patch("setEnabled", `${path}/:profile/enabled`, {
      params: target,
      payload: ProfileInputs.setEnabled.mapFields(
        ({ app: _app, profile: _profile, ...fields }) => fields,
      ),
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.post("reconcile", `${path}/:profile/reconcile`, {
      params: target,
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "run"),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${path}/:profile`, {
      params: target,
      success: Profile,
      error: errors,
    }).annotate(RequiredAction, "run"),
  )
  .middleware(RequireOrganization);
