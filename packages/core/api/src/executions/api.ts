import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  ExecutionId,
  ExecutionIdempotencyKey,
  ExecutionPauseSequence,
  ExecutionReceipt,
} from "@executor-js/sdk";
import { InternalError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExecuteRequest = Schema.Struct({
  idempotencyKey: ExecutionIdempotencyKey,
  code: Schema.String,
  // When true the caller is the human approver: approval-gated tools run to
  // completion instead of pausing. Set by the operator-facing Run/Test panel,
  // where clicking Run is itself the approval. `block` policies still apply.
  autoApprove: Schema.optional(Schema.Boolean),
  /**
   * Set when the caller is a rendered artifact rather than the console's own
   * code surface — the artifact page has no MCP client, so the shell reaches
   * the server here instead of through `execute-action`.
   *
   * It narrows the request in both directions: the code must be one
   * proxy-shaped tool call, and the integration role it names is resolved
   * through that artifact's stored connection bindings. Absent, this is
   * ordinary codemode and nothing changes.
   */
  artifactId: Schema.optional(Schema.String),
});

const ResumeRequest = Schema.Struct({
  idempotencyKey: ExecutionIdempotencyKey,
  pauseSequence: ExecutionPauseSequence,
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ExecutionNotFoundError = Schema.TaggedStruct("ExecutionNotFoundError", {
  executionId: ExecutionId,
}).annotate({ httpApiStatus: 404 });

const ExecutionInProgressError = Schema.TaggedStruct("ExecutionInProgressError", {
  executionId: ExecutionId,
}).annotate({ httpApiStatus: 409 });

const ExecutionIdempotencyConflictError = Schema.TaggedStruct("ExecutionIdempotencyConflictError", {
  executionId: ExecutionId,
  idempotencyKey: ExecutionIdempotencyKey,
}).annotate({ httpApiStatus: 409 });

const ExecutionResumeConflictError = Schema.TaggedStruct("ExecutionResumeConflictError", {
  executionId: ExecutionId,
  pauseSequence: ExecutionPauseSequence,
}).annotate({ httpApiStatus: 409 });

/**
 * The approval window closed before the human answered.
 *
 * Separate from `ExecutionNotFoundError` because the two mean different things
 * to the person clicking Approve: an unknown id is a client bug, while an
 * expired approval is an ordinary outcome with a clear next step — nothing ran,
 * so triggering the action again is safe. The shell renders this as its
 * expired-approval state rather than an error.
 */
const ApprovalExpiredError = Schema.TaggedStruct("ApprovalExpiredError", {
  executionId: ExecutionId,
})
  .annotate({ httpApiStatus: 410 })
  .annotate({
    description:
      "The approval window closed before the action was approved. Nothing ran; trigger the action again.",
  });

/**
 * An artifact-originated execution that could not be turned into a call: the
 * code was not the shell proxy's emission, the artifact is not this caller's,
 * or a role in it has no connection bound.
 *
 * `role` and `integration` accompany `binding_unresolved` so a client can offer
 * to rebind rather than only report the failure.
 */
const ArtifactActionError = Schema.TaggedStruct("ArtifactActionError", {
  error: Schema.Literals(["invalid_action_code", "artifact_unavailable", "binding_unresolved"]),
  reason: Schema.String,
  role: Schema.optional(Schema.String),
  integration: Schema.optional(Schema.String),
})
  .annotate({ httpApiStatus: 400 })
  .annotate({
    description:
      "A rendered artifact's tool call could not be resolved: bad shape, unknown artifact, or an unbound integration role.",
  });

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ExecutionParams = { executionId: ExecutionId };

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ExecutionsApi = HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.get("get", "/executions/:executionId", {
      params: ExecutionParams,
      success: ExecutionReceipt,
      error: [InternalError, ExecutionNotFoundError, ExecutionInProgressError],
    }),
  )
  .add(
    HttpApiEndpoint.post("execute", "/executions", {
      payload: ExecuteRequest,
      success: ExecutionReceipt,
      error: [
        InternalError,
        ArtifactActionError,
        ExecutionInProgressError,
        ExecutionIdempotencyConflictError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: ExecutionParams,
      payload: ResumeRequest,
      success: ExecutionReceipt,
      error: [
        InternalError,
        ExecutionNotFoundError,
        ApprovalExpiredError,
        ExecutionInProgressError,
        ExecutionResumeConflictError,
      ],
    }),
  );
