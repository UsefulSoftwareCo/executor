/** Retained workflow step messages before durable questions were added. */
import { Schema } from "effect";
import { JsonValue } from "../schema.ts";
import { WorkflowName, WorkflowStepOptions, WorkflowDuration } from "../workflows.ts";
export const WorkflowRpcCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("do"),
    name: WorkflowName,
    options: WorkflowStepOptions,
  }),
  Schema.Struct({
    operation: Schema.Literal("sleep"),
    name: WorkflowName,
    duration: WorkflowDuration,
  }),
  Schema.Struct({
    operation: Schema.Literal("until"),
    name: WorkflowName,
    timestamp: Schema.Finite,
  }),
  Schema.Struct({ operation: Schema.Literal("context") }),
  Schema.Struct({
    operation: Schema.Literal("invoke"),
    kind: Schema.Literals(["query", "mutation"]),
    name: Schema.NonEmptyString,
    input: JsonValue,
    stepId: Schema.NonEmptyString,
    timeout: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
