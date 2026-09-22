import { RequiredAction } from "./authorization.ts";
/** Authored app operations, scoped to an explicit hosted organization and configured app. */
import {
  ProfileId,
  ProfileRevision,
  AppDataErrors,
  AppDataSnapshot,
  AppId,
  DeploymentId,
  Json,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { AuthenticationUnavailable, Unauthorized } from "./auth.ts";

const params = { organization: OrganizationReference, app: AppId };
const payload = Schema.Struct({
  deployment: Schema.optional(DeploymentId),
  profile: Schema.optional(ProfileId),
  expectedProfileRevision: Schema.optional(ProfileRevision),
  name: Schema.NonEmptyString,
  input: Json,
});
const errors = [
  AppDataErrors,
  OrganizationForbidden,
  AuthenticationUnavailable,
  Unauthorized,
] as const;
const prefix = "/api/organizations/:organization/apps/:app/data";
/** Members may query; mutations follow hosted execution's administrator policy. */
export const HostedAppData = HttpApiGroup.make("appData")
  .add(
    HttpApiEndpoint.post("query", `${prefix}/query`, {
      params,
      payload,
      success: Json,
      error: errors,
    }).annotate(RequiredAction, "data"),
  )
  .add(
    HttpApiEndpoint.post("mutate", `${prefix}/mutate`, {
      params,
      payload,
      success: Json,
      error: errors,
    }).annotate(RequiredAction, "data"),
  )
  .add(
    HttpApiEndpoint.post("subscribe", `${prefix}/subscribe`, {
      params,
      payload,
      success: HttpApiSchema.StreamSse({ data: AppDataSnapshot, error: Schema.Union(errors) }),
      error: errors,
    }).annotate(RequiredAction, "data"),
  )
  .middleware(RequireOrganization);
