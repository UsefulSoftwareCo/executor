/** App-bound workflow input operations; products supply their own recipient and access checks. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  WorkflowInput,
  WorkflowInputId,
  WorkflowInputEvidence,
  ElicitationResponse,
} from "apps/contracts";
import { AppId, OwnerId } from "./shared.ts";
import { WorkflowErrors } from "./workflows.ts";

export { WorkflowInput, WorkflowInputId } from "apps/contracts";
export const WorkflowInputTarget = Schema.Struct({
  app: AppId,
  id: WorkflowInputId,
  owner: Schema.optional(OwnerId),
});
export const WorkflowInputPage = Schema.Struct({
  items: Schema.Array(WorkflowInput),
  next: Schema.optionalKey(WorkflowInputId),
});
export type WorkflowInputPage = typeof WorkflowInputPage.Type;
export const ListWorkflowInputs = Schema.Struct({
  owner: Schema.optional(OwnerId),
  app: Schema.optional(AppId),
  pending: Schema.optional(Schema.Boolean),
  after: Schema.optional(WorkflowInputId),
});
export const AnswerWorkflowInput = Schema.Struct({
  ...WorkflowInputTarget.fields,
  response: ElicitationResponse,
});
export const UpdateWorkflowInputEvidence = Schema.Struct({
  ...WorkflowInputTarget.fields,
  evidence: WorkflowInputEvidence,
});
const path = "/v1/apps/:app/workflow-inputs/:id";
export const WorkflowInputsGroup = HttpApiGroup.make("workflowInputs")
  .add(
    HttpApiEndpoint.get("list", "/v1/workflow-inputs", {
      query: ListWorkflowInputs,
      success: WorkflowInputPage,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", path, {
      params: { app: AppId, id: WorkflowInputId },
      query: { owner: Schema.optional(OwnerId) },
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("answer", `${path}/answer`, {
      params: { app: AppId, id: WorkflowInputId },
      payload: Schema.Struct({ owner: Schema.optional(OwnerId), response: ElicitationResponse }),
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateEvidence", `${path}/evidence`, {
      params: { app: AppId, id: WorkflowInputId },
      payload: Schema.Struct({ owner: Schema.optional(OwnerId), evidence: WorkflowInputEvidence }),
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("withdraw", `${path}/withdraw`, {
      params: { app: AppId, id: WorkflowInputId },
      payload: Schema.Struct({ owner: Schema.optional(OwnerId) }),
      success: WorkflowInput,
      error: WorkflowErrors,
    }),
  );
