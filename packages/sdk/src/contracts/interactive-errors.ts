/** Safe, retryable errors for app-owned account lifecycle operations. */
import { Schema } from "effect";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { AccountId } from "./shared.ts";
export const InteractiveRetirementBusy = UserFacingError.define({
  tag: "InteractiveRetirementBusy",
  status: 409,
  fields: { account: AccountId },
  presentation: ({ account }) => ({
    retryable: true,
    title: "Account removal is already running",
    description: `Another request is retiring account ${account}.`,
    recovery: {
      action: "Wait for that request, then retry.",
      instructions: "Do not run the app's remove handler again while the retirement claim is held.",
    },
  }),
});
export type InteractiveRetirementBusy = typeof InteractiveRetirementBusy.Type;
export const InteractiveRetirementFailed = UserFacingError.define({
  tag: "InteractiveRetirementFailed",
  status: 503,
  fields: { account: AccountId, reason: Schema.Literals(["remove", "authority", "active"]) },
  presentation: ({ account, reason }) => ({
    retryable: true,
    title: "App-owned account could not be removed",
    description: `Account ${account} could not be retired: ${reason === "authority" ? "you cannot delete this account" : reason === "active" ? "active work still uses it" : "the app's remove handler failed"}. No accounts or apps were deleted.`,
    recovery: {
      action: "Resolve the account's removal problem, then retry.",
      instructions:
        "Check deletion authority, active workflows and webhooks, and the acquiring app's remove handler. Successful removals are retained for the retry.",
    },
  }),
});
export type InteractiveRetirementFailed = typeof InteractiveRetirementFailed.Type;
export const InteractiveReconnectUnsupported = UserFacingError.define({
  tag: "InteractiveReconnectUnsupported",
  status: 422,
  fields: { account: AccountId },
  title: "Connect a new account",
  description: "An app-owned interactive account cannot update its credentials.",
  recovery: {
    action: "Connect a new account and remove the old one.",
    instructions:
      "Start a connection without account. Remove the old app-bound account after the new connection succeeds.",
  },
});
export type InteractiveReconnectUnsupported = typeof InteractiveReconnectUnsupported.Type;
