/**
 * Deleting your own Executor user. A host composes it only where people can sign up on their
 * own; self-host users are managed by the operator.
 */
import { Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AccountWebhooksActive,
  AccountWorkflowsActive,
  AppWorkflowsActive,
  StorageError,
} from "@executor-js/sdk/core";
import { AccountLinkedToApp } from "./accounts.ts";
import { AuthenticationUnavailable, RequireBrowserSession } from "./auth.ts";
import { OrganizationId } from "./organization.ts";
import { OrganizationRemovalUnavailable } from "./organization-removal.ts";

/**
 * What deleting the user does to one of their organizations. `delete`: they are its only
 * member, so it is deleted with everything it owns. `leave`: their personal accounts there are
 * deleted and their membership ends; the organization keeps what it shares. `blocked`: they are
 * its only owner and others remain, so they must delete it first.
 */
export const UserRemovalOutcome = Schema.Literals(["delete", "leave", "blocked"]);
export type UserRemovalOutcome = typeof UserRemovalOutcome.Type;

export const UserRemovalOrganization = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.String,
  outcome: UserRemovalOutcome,
});
export type UserRemovalOrganization = typeof UserRemovalOrganization.Type;

/** Everything deleting the user would touch, read before they confirm. */
export const UserRemovalPreview = Schema.Struct({
  organizations: Schema.Array(UserRemovalOrganization),
  /** Personal accounts in the organizations the user leaves; the others go with their organization. */
  personalAccounts: Schema.Int,
});
export type UserRemovalPreview = typeof UserRemovalPreview.Type;

/** The user is gone; these organizations are being erased by their removal workflows. */
export const UserRemoved = Schema.Struct({
  organizations: Schema.Array(OrganizationId),
  personalAccounts: Schema.Int,
});
export type UserRemoved = typeof UserRemoved.Type;

/** The only owner of an organization that has other members cannot leave it ownerless. */
export const UserRemovalBlocked = ApiError.define({
  tag: "UserRemovalBlocked",
  status: 409,
  fields: { organizations: Schema.Array(Schema.String) },
  message: ({ organizations }) =>
    `You are the only owner of ${organizations.join(", ")}, which ${organizations.length === 1 ? "has" : "have"} other members. Delete ${organizations.length === 1 ? "it" : "them"} first, then delete your user.`,
  recorded: () => "The user is the only owner of an organization with other members.",
});
export type UserRemovalBlocked = typeof UserRemovalBlocked.Type;

/** Browser-session only and irreversible. */
export const HostedUserRemoval = HttpApiGroup.make("userRemoval")
  .add(
    HttpApiEndpoint.get("preview", "/api/user/removal", {
      success: UserRemovalPreview,
      error: [AuthenticationUnavailable, StorageError],
    }).annotate(
      OpenApi.Description,
      "List what deleting the signed-in user would do to each of their organizations, and how many personal accounts it would delete.",
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/api/user", {
      success: UserRemoved,
      error: [
        UserRemovalBlocked,
        AuthenticationUnavailable,
        OrganizationRemovalUnavailable,
        StorageError,
        AppWorkflowsActive,
        AccountWorkflowsActive,
        AccountWebhooksActive,
        AccountLinkedToApp,
      ],
    }).annotate(
      OpenApi.Description,
      "Delete the signed-in user. Organizations where they are the only member are deleted with everything they own; in the others, their personal accounts are unlinked from apps and deleted with their saved credentials, and their membership ends. Their sessions, sign-in methods, passkeys, API keys and MCP grants are deleted. Refuses while they are the only owner of an organization with other members, or while running work or a webhook subscription still uses something it would delete. Requires a browser session.",
    ),
  )
  .middleware(RequireBrowserSession);
