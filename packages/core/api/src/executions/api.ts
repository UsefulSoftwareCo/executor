import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { InternalError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExecuteRequest = Schema.Struct({
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

const CompletedResult = Schema.Struct({
  status: Schema.Literal("completed"),
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});

const PausedResult = Schema.Struct({
  status: Schema.Literal("paused"),
  text: Schema.String,
  structured: Schema.Unknown,
});

const ExecuteResponse = Schema.Union([CompletedResult, PausedResult]);

const ResumeRequest = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Unknown),
});

const ResumeResponse = Schema.Union([CompletedResult, PausedResult]);

const PausedExecutionInfo = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
});

const ExecutionNotFoundError = Schema.TaggedStruct("ExecutionNotFoundError", {
  executionId: Schema.String,
}).annotate({ httpApiStatus: 404 });

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
  executionId: Schema.String,
})
  .annotate({ httpApiStatus: 410 })
  .annotate({
    description:
      "The approval window closed before the action was approved. Nothing ran; trigger the action again.",
  });

/**
 * The execution was interrupted by a daemon restart before it settled.
 *
 * Distinct from `ApprovalExpiredError` (the human never answered) and
 * `ExecutionNotFoundError` (an id that was never ours): an interrupted
 * execution is one the agent believed was still pending, but the service
 * restarted and the fiber is unrecoverable. The honest outcome is
 * "re-trigger the action" — nothing ran, so re-triggering is safe.
 * See execution-records.ts.
 */
const InterruptedExecutionError = Schema.TaggedStruct("InterruptedExecutionError", {
  executionId: Schema.String,
}).annotate({ httpApiStatus: 404 });

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

const ExecutionParams = { executionId: Schema.String };

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ExecutionsApi = HttpApiGroup.make("executions")
  .add(
    HttpApiEndpoint.get("getPaused", "/executions/:executionId", {
      params: ExecutionParams,
      success: PausedExecutionInfo,
      error: [InternalError, ExecutionNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("execute", "/executions", {
      payload: ExecuteRequest,
      success: ExecuteResponse,
      error: [InternalError, ArtifactActionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: ExecutionParams,
      payload: ResumeRequest,
      success: ResumeResponse,
      error: [
        InternalError,
        ExecutionNotFoundError,
        ApprovalExpiredError,
        InterruptedExecutionError,
      ],
    }),
  );
