/** Pure interaction contracts shared by MCP transports and browser clients. */
import { Schema } from "effect";
import {
  AppId,
  ApprovalRequestId,
  ProfileId,
  ProfileRevision,
  ToolName,
  ToolPending,
} from "@executor-js/sdk/core";
import { FormElicitation } from "apps/contracts";
/** Live tool questions have ephemeral identities, separate from persisted SDK approval IDs. */
export const ElicitationRequestId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^elc_[\s\S]+$/u)),
  Schema.brand("elc"),
);
/** Both delivery modes answer one pending interaction through the same resume operation. */
export const InteractionId = Schema.Union([ApprovalRequestId, ElicitationRequestId]);
export type InteractionId = typeof InteractionId.Type;
/**
 * The running call that asked. A call without a profile, such as one to an account-free app,
 * omits both profile keys: pending interactions are MCP results, and JSON has no undefined.
 */
export const InteractionTool = Schema.Struct({
  app: AppId,
  tool: ToolName,
  profile: Schema.optionalKey(ProfileId),
  expectedProfileRevision: Schema.optionalKey(ProfileRevision),
});
export type InteractionTool = typeof InteractionTool.Type;
/** A question from an already-running tool. It is not a new tool invocation or a stored approval. */
export const ToolInputPending = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: ElicitationRequestId,
  tool: InteractionTool,
  elicitation: FormElicitation,
  expiresAt: Schema.Number,
});
/** Transport-neutral pending interaction; its status distinguishes the continuation it owns. */
export const PendingInteraction = Schema.Union([ToolPending, ToolInputPending]);
export type PendingInteraction = typeof PendingInteraction.Type;
/** Invalid form response. It does not consume the SDK request or its live continuation. */
export class ElicitationResponseInvalid extends Schema.TaggedError<ElicitationResponseInvalid>()(
  "ElicitationResponseInvalid",
  {},
) {}
