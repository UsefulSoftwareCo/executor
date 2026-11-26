import { Schema } from "effect";
import {
  AppAccounts,
  AppId,
  ApprovalRequestId,
  ToolName,
  ToolPending,
} from "@executor-js/sdk/core";
import { FormElicitation } from "apps/contracts";
export const ElicitationRequestId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^elc_[\s\S]+$/u)),
  Schema.brand("elc"),
);
export const InteractionId = Schema.Union([ApprovalRequestId, ElicitationRequestId]);
export type InteractionId = typeof InteractionId.Type;
export const InteractionTool = Schema.Struct({
  app: AppId,
  tool: ToolName,
  accounts: Schema.optionalKey(AppAccounts),
});
export type InteractionTool = typeof InteractionTool.Type;
export const ToolInputPending = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: ElicitationRequestId,
  tool: InteractionTool,
  elicitation: FormElicitation,
  expiresAt: Schema.Number,
});
export const PendingInteraction = Schema.Union([ToolPending, ToolInputPending]);
export type PendingInteraction = typeof PendingInteraction.Type;
export class ElicitationResponseInvalid extends Schema.TaggedError<ElicitationResponseInvalid>()(
  "ElicitationResponseInvalid",
  {},
) {}
