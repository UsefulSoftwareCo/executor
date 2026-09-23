/** Tool-owned approval policies, evaluated after native input decoding. */
import { Schema, type Effect } from "effect";

/** Approve this call, deny it, or stop for a human decision. */
export const ApprovalDecision = Schema.Literals(["approved", "denied", "user-approval"]);
/** Parsed result of one tool approval policy. */
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** Context for one tool's policy. toolInput is the same decoded value passed to run. */
export interface ApprovalContext<Input = unknown> {
  readonly toolName: string;
  readonly toolInput: Input;
  readonly signal: AbortSignal;
}

/** Native policy for this tool only. Failures prevent execution and remain private. */
export type Approval<Input = unknown> = (
  context: ApprovalContext<Input>,
) => Effect.Effect<ApprovalDecision, unknown>;
