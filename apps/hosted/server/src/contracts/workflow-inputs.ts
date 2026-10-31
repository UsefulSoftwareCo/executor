/** Durable workflow questions share the product's authenticated Approvals boundary. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  AppId,
  WorkflowInput,
  WorkflowInputId,
  WorkflowInputPage,
  WorkflowErrors,
} from "@executor-js/sdk/core";
import { ElicitationResponse, WorkflowInputEvidence } from "apps/contracts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { BrowserSessionOnly, Forbidden } from "./auth.ts";
const errors = [...WorkflowErrors, OrganizationForbidden, Forbidden] as const;
const organization = { organization: OrganizationReference };
const target = { ...organization, app: AppId, id: WorkflowInputId };
const path = "/api/organizations/:organization/apps/:app/workflow-inputs/:id";
export const HostedWorkflowInputs = HttpApiGroup.make("workflowInputs")
  .add(
    HttpApiEndpoint.get("list", "/api/organizations/:organization/workflow-inputs", {
      params: organization,
      query: {
        app: Schema.optional(AppId),
        pending: Schema.optional(Schema.Boolean),
        after: Schema.optional(WorkflowInputId),
      },
      success: WorkflowInputPage,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", path, {
      params: target,
      success: WorkflowInput,
      error: errors,
    }).annotate(BrowserSessionOnly, true),
  )
  .add(
    HttpApiEndpoint.post("answer", path, {
      params: target,
      payload: Schema.Struct({ response: ElicitationResponse }),
      success: WorkflowInput,
      error: errors,
    }).annotate(BrowserSessionOnly, true),
  )
  .add(
    HttpApiEndpoint.post("updateEvidence", `${path}/evidence`, {
      params: target,
      payload: Schema.Struct({ evidence: WorkflowInputEvidence }),
      success: WorkflowInput,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("withdraw", `${path}/withdraw`, {
      params: target,
      success: WorkflowInput,
      error: errors,
    }),
  )
  .middleware(RequireOrganization);
