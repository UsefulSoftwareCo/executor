/** Safe failure markers survive the native workflow engine's error serialization. */
import { Schema, Option } from "effect";
import { WorkflowFailure } from "apps/contracts";

/** Preserve only safe reason/retry metadata through native Workflow error serialization. */
export const workflowFailureMessage = (failure: WorkflowFailure) =>
  `ExecutorWorkflowFailure(${failure.reason},${failure.retryable})`;
/** Native engines can wrap exception names; recover only our validated, credential-free marker. */
export const decodeWorkflowFailure = (error: unknown): WorkflowFailure => {
  if (Schema.is(WorkflowFailure)(error)) return error;
  const message = error instanceof Error ? error.message : "";
  const match = /ExecutorWorkflowFailure\(([a-z_]+),(true|false)\)/.exec(message);
  if (match !== null) {
    const parsed = Schema.decodeUnknownOption(WorkflowFailure.fields.reason)(match[1]);
    if (Option.isSome(parsed))
      return new WorkflowFailure({ reason: parsed.value, retryable: match[2] === "true" });
  }
  return new WorkflowFailure({ reason: "engine", retryable: true });
};
