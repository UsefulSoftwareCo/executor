/** Organization authorization surrounds app-scoped workflow lifecycle operations. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AppId,
  ProfileId,
  ProfileRevision,
  DeploymentId,
  WorkflowRunId,
  HostedWorkflow,
  WorkflowRun,
  WorkflowRunPage,
  StartWorkflow,
  ListWorkflowRuns,
  WorkflowErrors,
} from "@executor-js/sdk/core";
import { ExecutionLimitReached, ExecutionAdmissionUnavailable } from "./execution-admission.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
const app = { organization: OrganizationReference, app: AppId };
const run = { ...app, run: WorkflowRunId };
const errors = [...WorkflowErrors, OrganizationForbidden] as const;
const path = "/api/organizations/:organization/apps/:app";
/** Definitions and run state are readable by members; starting/terminating requires an administrator. */
export const HostedWorkflows = HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("definitions", `${path}/workflows`, {
      params: app,
      query: {
        profile: Schema.optional(ProfileId),
        expectedProfileRevision: Schema.optional(ProfileRevision),
        deployment: Schema.optional(DeploymentId),
      },
      success: Schema.Array(HostedWorkflow),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("start", `${path}/workflow-runs`, {
      params: app,
      payload: StartWorkflow.mapFields(({ app: _app, ...fields }) => fields),
      success: WorkflowRun,
      error: [...errors, ExecutionLimitReached, ExecutionAdmissionUnavailable],
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
