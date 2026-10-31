/** The local subject reviews durable questions through the paired dashboard. */
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
const target = { app: AppId, id: WorkflowInputId };
const path = "/dashboard/api/apps/:app/workflow-inputs/:id";
export const DashboardWorkflowInputs = HttpApiGroup.make("workflowInputs")
  .add(
    HttpApiEndpoint.get("list", "/dashboard/api/workflow-inputs", {
      query: {
        app: Schema.optional(AppId),
        pending: Schema.optional(Schema.Boolean),
        after: Schema.optional(WorkflowInputId),
      },
      success: WorkflowInputPage,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", path, {
      params: target,
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("answer", path, {
      params: target,
      payload: Schema.Struct({ response: ElicitationResponse }),
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateEvidence", `${path}/evidence`, {
      params: target,
      payload: Schema.Struct({ evidence: WorkflowInputEvidence }),
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("withdraw", `${path}/withdraw`, {
      params: target,
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  );
