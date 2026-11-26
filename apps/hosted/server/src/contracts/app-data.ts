import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { RequiredAction } from "./authorization.ts";
import { AppDataErrors, AppDataSnapshot, AppId, VersionId, Json } from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { AuthenticationUnavailable, Unauthorized } from "./auth.ts";

const params = { organization: OrganizationReference, app: AppId };
const payload = Schema.Struct({
  version: Schema.optional(VersionId),
  name: Schema.NonEmptyString,
  input: Json,
}).pipe(withLegacyKeys({ version: "deployment" }));
const errors = [
  AppDataErrors,
  OrganizationForbidden,
  AuthenticationUnavailable,
  Unauthorized,
] as const;
const prefix = "/api/organizations/:organization/apps/:app/data";
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
