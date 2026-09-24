import { RequiredAction } from "./authorization.ts";
/** Organization-scoped skill reads expose only the skill directory, never general app source. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
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
const version = SkillSelection;
const prefix = "/api/organizations/:organization/apps/:app/skills";
/** App and account permissions authorize dynamic skill discovery. */
export const HostedSkills = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("bundle", "/api/organizations/:organization/apps/:app/skill-bundle", {
      params: app,
      query: version,
      success: AppSkillBundle,
      error: AppSkillErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("list", prefix, {
      params: app,
      query: version,
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.get("read", `${prefix}/:name`, {
      params: { ...app, name: AppSkillName },
      query: { ...version, file: Schema.optional(SourceFilePath) },
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .middleware(RequireOrganization);
