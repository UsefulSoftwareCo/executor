/** Organization authorization surrounds app-scoped workflow lifecycle operations. */
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AppId,
  VersionId,
  WorkflowRunId,
  HostedWorkflow,
  WorkflowRun,
  WorkflowRunPage,
  StartWorkflowFields,
  ListWorkflowRuns,
  WorkflowErrors,
  WorkflowDefinitionErrors,
} from "@executor-js/sdk/core";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
const app = { organization: OrganizationReference, app: AppId };
const run = { ...app, run: WorkflowRunId };
const errors = [...WorkflowErrors, OrganizationForbidden] as const;
const definitionErrors = [...WorkflowDefinitionErrors, OrganizationForbidden] as const;
const path = "/api/organizations/:organization/apps/:app";
/**
 * Members who can use the app read definitions and start runs with their accounts. Runs belong to
 * the actor that started them; terminating someone else's run needs app management.
 */
export const HostedWorkflows = HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("definitions", `${path}/workflows`, {
      params: app,
      query: Schema.Struct({ version: Schema.optional(VersionId) }).pipe(
        withLegacyKeys({ version: "deployment" }),
      ),
      success: Schema.Array(HostedWorkflow),
      error: definitionErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("start", `${path}/workflow-runs`, {
      params: app,
      payload: StartWorkflowFields.mapFields(
        ({ app: _app, accounts: _accounts, ...fields }) => fields,
      ).pipe(withLegacyKeys({ version: "deployment" })),
      success: WorkflowRun,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", `${path}/workflow-runs/:run`, {
      params: run,
      success: WorkflowRun,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", `${path}/workflow-runs`, {
      params: app,
      query: ListWorkflowRuns.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRunPage,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("terminate", `${path}/workflow-runs/:run/terminate`, {
      params: run,
      success: WorkflowRun,
      error: errors,
    }),
  )
  .middleware(RequireOrganization);
