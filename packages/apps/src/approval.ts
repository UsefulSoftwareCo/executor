/** Tool approval author API; no state or execution starts during declaration. */
import type { Effect } from "effect";
import type { Approval as NativeApproval } from "./contracts/approval.ts";
export type { ApprovalContext, ApprovalDecision } from "./contracts/approval.ts";

/** Synchronous or async policy, projected from the framework's native contract. */
export type Approval<Input = unknown> = (
  ...args: Parameters<NativeApproval<Input>>
) =>
  | Effect.Success<ReturnType<NativeApproval<Input>>>
  | Promise<Effect.Success<ReturnType<NativeApproval<Input>>>>;

/** Require human approval for every call to the tool. */
export const always =
  <Input = unknown>(): Approval<Input> =>
  () =>
    "user-approval";

/** Never require human approval for this tool. Product access checks still apply. */
export const never =
  <Input = unknown>(): Approval<Input> =>
  () =>
    "approved";
