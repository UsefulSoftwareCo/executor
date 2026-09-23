/** Browser delivery data. URLs locate an interaction; hosts must authorize every read and answer. */
import { Schema, type Effect } from "effect";
import { ElicitationResponse } from "apps/contracts";
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
