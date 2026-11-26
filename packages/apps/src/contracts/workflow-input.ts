/** Durable workflow questions reuse standard forms without retaining a tool invocation. */
import { Schema } from "effect";
import { ElicitationResponse, FormElicitation } from "./elicitation.ts";

export const WorkflowInputId = Schema.NonEmptyString.check(
  Schema.isPattern(/^wfi_[a-f0-9]{64}$/u),
).pipe(Schema.brand("wfi"));
export type WorkflowInputId = typeof WorkflowInputId.Type;

/** Links point to existing authenticated pages; they grant no authority. */
export const WorkflowInputLink = Schema.Struct({
  label: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
  href: Schema.NonEmptyString.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((href) => {
      try {
        const url = new URL(href, "https://workflow.invalid");
        return (
          ((href.startsWith("/") && !href.startsWith("//")) || url.protocol === "https:") &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    }),
  ),
});
/** Current facts beside an unchanged decision. They grant no authority and contain no secrets. */
export const WorkflowInputEvidence = Schema.Array(
  Schema.Struct({
    label: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
    value: Schema.String.check(Schema.isMaxLength(500)),
  }),
).check(Schema.isMaxLength(12));
export type WorkflowInputEvidence = typeof WorkflowInputEvidence.Type;

export const WorkflowInputRequest = Schema.Struct({
  form: FormElicitation,
  evidence: Schema.optionalKey(WorkflowInputEvidence),
  /** A human deadline, separate from an active step's execution timeout. */
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 86400000 })),
  links: Schema.optionalKey(Schema.Array(WorkflowInputLink).check(Schema.isMaxLength(8))),
});
/** A standard form, its human deadline and links to existing product pages. */
export type WorkflowInputRequest = typeof WorkflowInputRequest.Type;

export const WorkflowInputStatus = Schema.Literals(["pending", "answered", "expired", "withdrawn"]);
export const WorkflowInput = Schema.Struct({
  id: WorkflowInputId,
  run: Schema.NonEmptyString,
  app: Schema.NonEmptyString,
  workflow: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  status: WorkflowInputStatus,
  expiresAt: Schema.Finite,
  /** Supplied by the product, never by authored code. */
  reviewUrl: Schema.optionalKey(Schema.String),
  form: FormElicitation,
  evidence: WorkflowInputEvidence,
  links: Schema.Array(WorkflowInputLink),
  response: Schema.optionalKey(ElicitationResponse),
});
/** The retained question and its committed state, with an authenticated review link when supported. */
export type WorkflowInput = typeof WorkflowInput.Type;

export const WorkflowInputOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), response: ElicitationResponse }),
  Schema.Struct({ status: Schema.Literals(["expired", "withdrawn"]) }),
]);
/** A saved answer or an explicit end to the wait; neither establishes that a repair succeeded. */
export type WorkflowInputOutcome = typeof WorkflowInputOutcome.Type;

/** An execution callback is bound to one run and cannot select another run or recipient. */
export const WorkflowInputCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("request"),
    stepId: Schema.NonEmptyString,
    name: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
    request: WorkflowInputRequest,
  }),
  Schema.Struct({ operation: Schema.Literal("get"), id: WorkflowInputId }),
]);
export type WorkflowInputCommand = typeof WorkflowInputCommand.Type;
