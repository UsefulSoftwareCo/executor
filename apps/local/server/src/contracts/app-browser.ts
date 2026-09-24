/** Paired dashboard reads for app skills under the selected profile. */
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AppId,
  SkillSelection,
  AppSkillInputs,
  AppSkillCatalog,
  AppSkillBundle,
  AppSkillDocument,
  AppSkillErrors,
  AppSkillNotFound,
} from "@executor-js/sdk/core";

const params = { app: AppId };
const prefix = "/dashboard/api/apps/:app";
/** The containing API supplies DashboardAccess to every endpoint. */
export const DashboardAppBrowser = HttpApiGroup.make("appBrowser")
  .add(
    HttpApiEndpoint.get("skillBundle", `${prefix}/skill-bundle`, {
      params,
      query: SkillSelection,
      success: AppSkillBundle,
      error: AppSkillErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skills", `${prefix}/skills`, {
      params,
      query: SkillSelection,
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skill", `${prefix}/skills/:name`, {
      params: { ...params, name: AppSkillInputs.read.fields.name },
      query: {
        ...SkillSelection,
        file: AppSkillInputs.read.fields.file,
      },
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }),
  );
