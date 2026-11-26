import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { RequiredAction } from "./authorization.ts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AppId,
  SkillSelection,
  AppSkillName,
  AppSkillCatalog,
  AppSkillBundle,
  AppSkillDocument,
  AppSkillErrors,
  AppSkillNotFound,
  SourceFilePath,
} from "@executor-js/sdk/core";
import { OrganizationReference, RequireOrganization } from "./organization.ts";

const app = { organization: OrganizationReference, app: AppId };
const version = { version: SkillSelection.version, revision: SkillSelection.revision };
const prefix = "/api/organizations/:organization/apps/:app/skills";
export const HostedSkills = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/api/organizations/:organization/apps/:app/skill-bundle", {
      params: app,
      query: Schema.Struct(version).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillBundle,
      error: AppSkillErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("list", prefix, {
      params: app,
      query: Schema.Struct(version).pipe(withLegacyKeys({ version: "deployment" })),
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("read", `${prefix}/:name`, {
      params: { ...app, name: AppSkillName },
      query: Schema.Struct({ ...version, file: Schema.optional(SourceFilePath) }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .middleware(RequireOrganization);
