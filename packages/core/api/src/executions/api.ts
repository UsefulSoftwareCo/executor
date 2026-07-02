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
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: ExecutionParams,
      payload: ResumeRequest,
      success: ResumeResponse,
      error: [InternalError, ExecutionNotFoundError],
    }),
  );
