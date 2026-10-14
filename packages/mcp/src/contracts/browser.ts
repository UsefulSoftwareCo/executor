/** Browser delivery data. URLs locate an interaction; hosts must authorize every read and answer. */
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
export { InteractionId, PendingInteraction, ElicitationResponseInvalid, ElicitationResponse };

/** Session routing is public metadata, never an authentication credential. */
export const BrowserSessionId = Schema.NonEmptyString.check(Schema.isMaxLength(512));
/** Product-neutral address within the authenticated host's MCP session partition. */
export const BrowserApprovalAddress = Schema.Struct({
  requestId: InteractionId,
  sessionId: BrowserSessionId,
});
export type BrowserApprovalAddress = typeof BrowserApprovalAddress.Type;
/** Only a live pending view contains private invocation data and form fields. */
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
/** Submitting twice never changes the first answer. Submission does not execute a tool. */
export const BrowserApprovalAcknowledgement = Schema.Struct({
  status: Schema.Literals(["answered", "unavailable"]),
});
export type BrowserApprovalAcknowledgement = typeof BrowserApprovalAcknowledgement.Type;
/** The browser submits only the response to the request it was shown. */
export const BrowserApprovalAnswer = Schema.Struct({ response: ElicitationResponse });
/**
 * A person's own dashboard run: its result, or the stored request they review before it runs.
 * The host binds the request to that person's run; the review reads the saved call from the server.
 */
export const BrowserToolRun = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), value: Json }),
  Schema.Struct({ status: Schema.Literal("approval-required"), requestId: ApprovalRequestId }),
]);
export type BrowserToolRun = typeof BrowserToolRun.Type;
/**
 * Answering a dashboard run's review resumes the saved call in the same request and returns its
 * outcome. Unlike a delivered approval, the person who answers is the one waiting for the result.
 */
export const BrowserToolRunAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), result: ToolResumeResult }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type BrowserToolRunAnswer = typeof BrowserToolRunAnswer.Type;
/** The answer as a dashboard receives it, possibly from the previous release's server. */
export const BrowserToolRunAnswerReceived = Schema.Union([
  Schema.Struct({ status: Schema.Literal("answered"), result: ToolResumeResultReceived }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type BrowserToolRunAnswerReceived = typeof BrowserToolRunAnswerReceived.Type;
/**
 * A dashboard reviews only requests issued by the signed-in person's own run from it. Approvals from
 * MCP, schedules, API calls or another person's run are answered only in the flow that issued them.
 * `unrecorded` requests name no dashboard run: another flow issued them, or they were saved before
 * dashboards recorded their runs. `another-person` requests belong to someone else's dashboard run.
 */
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
/** Hosts build links from a configured origin and server-derived product identity. */
export interface BrowserDelivery {
  readonly url: (address: BrowserApprovalAddress) => Effect.Effect<string>;
  /** Bounded MCP long-poll; a timeout returns the same pending request, without consuming it. */
  readonly pollMs?: number;
}
/** Cookie-authorized hosts access the same manager used by MCP. They supply the verified product identity. */
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
