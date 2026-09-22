/** Paired dashboard reads for static skills and durable workflow history. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AppId,
  AppSkillInputs,
  AppSkillCatalog,
  AppSkillBundle,
  AppSkillDocument,
  AppSkillErrors,
  AppSkillNotFound,
  HostedWorkflow,
  WorkflowRunPage,
  ListWorkflowRuns,
  WorkflowErrors,
} from "@executor-js/sdk/core";

const params = { app: AppId };
const prefix = "/dashboard/api/apps/:app";
/** The containing API supplies DashboardAccess to every endpoint. */
export const DashboardAppBrowser = HttpApiGroup.make("appBrowser")
  .add(
    HttpApiEndpoint.get("skillBundle", `${prefix}/skill-bundle`, {
      params,
      query: { deployment: AppSkillInputs.list.fields.deployment },
      success: AppSkillBundle,
      error: AppSkillErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skills", `${prefix}/skills`, {
      params,
      query: { deployment: AppSkillInputs.list.fields.deployment },
      success: AppSkillCatalog,
      error: AppSkillErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skill", `${prefix}/skills/:name`, {
      params: { ...params, name: AppSkillInputs.read.fields.name },
      query: {
        deployment: AppSkillInputs.read.fields.deployment,
        file: AppSkillInputs.read.fields.file,
      },
      success: AppSkillDocument,
      error: [...AppSkillErrors, AppSkillNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("workflows", `${prefix}/workflows`, {
      params,
      success: Schema.Array(HostedWorkflow),
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("runs", `${prefix}/workflow-runs`, {
      params,
      query: ListWorkflowRuns.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRunPage,
      error: WorkflowErrors,
    }),
  );
