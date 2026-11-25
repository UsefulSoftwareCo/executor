import { Schema, type Effect } from "effect";
import { ElicitationResponse } from "apps/contracts";
import {
  ApprovalRequestId,
  Json,
  ToolResumeResult,
  ToolResumeResultReceived,
} from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { InteractionId, PendingInteraction, ElicitationResponseInvalid } from "./interactions.ts";
import { ToolCallReference } from "./call-log.ts";
export {
  InteractionId,
  PendingInteraction,
  ElicitationResponseInvalid,
  ElicitationResponse,
  ToolCallReference,
};

export const BrowserSessionId = Schema.NonEmptyString.check(Schema.isMaxLength(512));
export const BrowserApprovalAddress = Schema.Struct({
  requestId: InteractionId,
  sessionId: BrowserSessionId,
});
export type BrowserApprovalAddress = typeof BrowserApprovalAddress.Type;
export const BrowserApprovalView = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    request: PendingInteraction,
    appName: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("answered") }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type BrowserApprovalView = typeof BrowserApprovalView.Type;
export const BrowserApprovalAcknowledgement = Schema.Struct({
  status: Schema.Literals(["answered", "unavailable"]),
});
export type BrowserApprovalAcknowledgement = typeof BrowserApprovalAcknowledgement.Type;
export const BrowserApprovalAnswer = Schema.Struct({ response: ElicitationResponse });
export const BrowserToolRun = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    value: Json,
    reference: Schema.optionalKey(ToolCallReference),
  }),
  Schema.Struct({ status: Schema.Literal("approval-required"), requestId: ApprovalRequestId }),
]);
export type BrowserToolRun = typeof BrowserToolRun.Type;
export const BrowserToolRunAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answered"),
    result: ToolResumeResult,
    reference: Schema.optionalKey(ToolCallReference),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reference: Schema.optionalKey(ToolCallReference),
  }),
]);
export type BrowserToolRunAnswer = typeof BrowserToolRunAnswer.Type;
export const BrowserToolRunAnswerReceived = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answered"),
    result: ToolResumeResultReceived,
    reference: Schema.optionalKey(ToolCallReference),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reference: Schema.optionalKey(ToolCallReference),
  }),
]);
export type BrowserToolRunAnswerReceived = typeof BrowserToolRunAnswerReceived.Type;
export const ToolRunApprovalRefused = UserFacingError.define({
  tag: "ToolRunApprovalRefused",
  status: 403,
  fields: { reason: Schema.Literals(["unrecorded", "another-person"]) },
  presentation: ({ reason }) =>
    reason === "another-person"
      ? {
          title: "Another person’s run",
          description:
            "Another person started this run from the Tools tab, so only they can review or answer it.",
          recovery: {
            action: "Leave this request to them. To make this call yourself, run the tool again.",
            instructions:
              "A dashboard approval is reviewed only by the person whose run from the Tools tab requested it. Do not retry this request here. To make the call yourself, run the tool from your own Tools tab and review the request it shows you.",
          },
        }
      : {
          title: "Approval not requested from the Tools tab",
          description:
            "This request does not record a run of yours from the Tools tab, so it cannot be reviewed here. An MCP client, a schedule or an API call may have requested it, or it was saved before the Tools tab recorded its runs.",
          recovery: {
            action:
              "If you started it from the Tools tab, run the tool again there and review the new request. Otherwise answer it where it was requested: in the MCP client, on the scheduled run’s review or through the API.",
            instructions:
              "Each approval is answered only through the flow that issued it. Resume an MCP approval with the MCP resume tool from the same connection, answer a scheduled run on its review page and resume an API call through the API that made it. A dashboard request saved before runs were recorded cannot be answered: run the tool again from the Tools tab. Do not retry this request here.",
          },
        },
  recorded: ({ reason }) =>
    reason === "another-person"
      ? "The dashboard refused a review: the request belongs to another person's run."
      : "The dashboard refused a review: the request records no run from the Tools tab.",
});
export type ToolRunApprovalRefused = typeof ToolRunApprovalRefused.Type;
export interface BrowserDelivery {
  readonly url: (address: BrowserApprovalAddress) => Effect.Effect<string>;
  readonly pollMs?: number;
}
export interface BrowserApprovals {
  readonly get: (
    product: string,
    address: BrowserApprovalAddress,
  ) => Effect.Effect<BrowserApprovalView>;
  readonly answer: (
    product: string,
    address: BrowserApprovalAddress,
    response: typeof ElicitationResponse.Type,
  ) => Effect.Effect<BrowserApprovalAcknowledgement, ElicitationResponseInvalid>;
}
