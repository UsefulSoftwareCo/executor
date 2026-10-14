/** Why an account cannot be linked to an app requirement, shared by the dashboard and agent routes. */
import { AccountScope, AppId } from "@executor-js/sdk";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { Schema } from "effect";

const mismatch = {
  requirement: {
    title: "This app has no such account requirement here",
    description: (scope: AccountScope) =>
      scope === "app"
        ? "The app's active deployment doesn't declare this requirement as one of its own, linked for every call."
        : "The app's active deployment doesn't declare this requirement as one you link for yourself.",
    action: (scope: AccountScope) =>
      scope === "app"
        ? "Link the account to one of the app's own requirements, or to a user requirement under Your accounts."
        : "Link the account to one of the app's user requirements, or to one of its own requirements under App accounts.",
  },
  provider: {
    title: "This requirement uses another kind of account",
    description: () => "The account's provider is not the one this requirement uses.",
    action: () =>
      "Link an account from the provider this requirement names, or connect one for it.",
  },
} as const;
/**
 * The account cannot be linked to this requirement in this scope: the app's active deployment
 * does not declare the requirement in it (`requirement`), or the account's provider is not the
 * requirement's (`provider`).
 */
export const RequirementMismatch = UserFacingError.define({
  tag: "RequirementMismatch",
  status: 422,
  fields: {
    app: AppId,
    requirement: Schema.String,
    scope: AccountScope,
    reason: Schema.Literals(["requirement", "provider"]),
  },
  recorded: ({ scope, reason }) =>
    `The account cannot be linked to this ${scope} requirement: ${reason}`,
  presentation: ({ scope, reason }) => ({
    title: mismatch[reason].title,
    description: mismatch[reason].description(scope),
    recovery: {
      action: mismatch[reason].action(scope),
      instructions:
        "Read the app's account requirements and their scopes with appAccounts.appList or appAccounts.userList, and the accounts a requirement takes with appAccounts.appGet or appAccounts.userGet. Link only accounts of the provider the requirement names, in the requirement's own scope. Do not change the app's requirements to fit an account.",
    },
  }),
});
/** Parsed RequirementMismatch failure. */
export type RequirementMismatch = typeof RequirementMismatch.Type;
