/** Pure interaction contracts shared by MCP transports and browser clients. */
import { Schema } from "effect";
import { ApprovalRequestId, ToolInputs, ToolPending } from "@executor-js/sdk/core";
import { FormElicitation } from "apps/contracts";
/** Live tool questions have ephemeral identities, separate from persisted SDK approval IDs. */
export const ElicitationRequestId = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("elc_"), Schema.isMinLength(5)),
  Schema.brand("elc"),
);
/** Both delivery modes answer one pending interaction through the same resume operation. */
export const InteractionId = Schema.Union([ApprovalRequestId, ElicitationRequestId]);
export type InteractionId = typeof InteractionId.Type;
/** A question from an already-running tool. It is not a new tool invocation or a stored approval. */
export const ToolInputPending = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: ElicitationRequestId,
  tool: Schema.Struct({
    app: ToolInputs.call.fields.app,
    tool: ToolInputs.call.fields.tool,
    profile: ToolInputs.call.fields.profile,
    expectedProfileRevision: ToolInputs.call.fields.expectedProfileRevision,
  }),
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
