import { RequiredAction } from "./authorization.ts";
import { OrganizationDefaultsError } from "./organization-defaults.ts";
/** Hosted sharing policy stays separate from SDK tenant ownership and saved bindings. */
import {
  App,
  Account,
  Provider,
  AppId,
  AccountId,
  AccountConnectionId,
  StorageError,
  AccountSelectionInvalid,
  AccountNotFound,
  AppNotFound,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Principal } from "./auth.ts";
import { GroupId } from "./groups.ts";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

/** Concurrent settings updates compare an opaque revision before changing any grant. */
export const AccessRevision = Schema.NonEmptyString.pipe(Schema.brand("AccessRevision"));
/** A group grant is a duplicate-free union; removing its last group leaves no users. */
export const GroupAudience = Schema.Struct({
  kind: Schema.Literal("groups"),
  groups: Schema.Array(GroupId).check(
    Schema.isMaxLength(1000),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
/** Shared credentials can be granted to groups or all organization members. */
export const SharedAudience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("everyone") }),
  GroupAudience,
]);
/** Private app access refers to its recorded creator, not a user-selectable person grant. */
export const AppAudience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("private") }),
  SharedAudience,
]);
/** Each configured app has its own independent access policy. */
export const AppAccess = Schema.Struct({
  app: AppId,
  creator: Schema.NullOr(Principal.fields.userId),
  audience: AppAudience,
  revision: AccessRevision,
  canManage: Schema.Boolean,
  canUse: Schema.Boolean,
});
/** Personal ownership is immutable; shared credentials have independently editable grants. */
export const AccountOwnership = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("personal"), user: Principal.fields.userId }),
  Schema.Struct({ kind: Schema.Literal("shared"), audience: SharedAudience }),
]);
/** Safe account policy metadata; personal policies are readable only by their owner. */
export const AccountAccess = Schema.Struct({
  account: AccountId,
  creator: Schema.NullOr(Principal.fields.userId),
  ownership: AccountOwnership,
  revision: AccessRevision,
  canManage: Schema.Boolean,
  canUse: Schema.Boolean,
});
/** The selected destination is persisted before a connection link is exposed. */
export const ConnectionDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("personal") }),
  Schema.Struct({ kind: Schema.Literal("shared"), audience: SharedAudience }),
]);
/** Safe connection intent contains no credentials or OAuth tokens. */
export const ConnectionAccess = Schema.Struct({
  connection: AccountConnectionId,
  creator: Principal.fields.userId,
  destination: ConnectionDestination,
  target: Schema.NullOr(Schema.Struct({ app: AppId, requirement: Schema.NonEmptyString })),
});
/** A stale revision or removed group must preserve the editor's draft. */
export class AccessConflict extends Schema.TaggedError<AccessConflict>()(
  "AccessConflict",
  {
    reason: Schema.Literals([
      "changed",
      "groups_changed",
      "creator_unavailable",
      "personal_account",
    ]),
  },
  { httpApiStatus: 409 },
) {}
const organization = { organization: OrganizationReference };
const app = { ...organization, app: AppId };
const account = { ...organization, account: AccountId };
const errors = [
  OrganizationForbidden,
  StorageError,
  AccessConflict,
  AccountSelectionInvalid,
  AccountNotFound,
  AppNotFound,
  ...OrganizationDefaultsError.members,
];
/** Normal lists show use grants; management mode is explicit and never grants execution. */
export const ResourceDirectory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ app: App, access: AppAccess })),
  accounts: Schema.Array(
    Schema.Struct({ account: Account, access: AccountAccess, provider: Provider }),
  ),
});
/** Resource policy and member preferences are product endpoints, not generic SDK operations. */
export const HostedResourceAccess = HttpApiGroup.make("resourceAccess")
  .add(
    HttpApiEndpoint.get("directory", "/api/organizations/:organization/resources", {
      params: organization,
      query: { view: Schema.optional(Schema.Literals(["available", "managed"])) },
      success: ResourceDirectory,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("app", "/api/organizations/:organization/apps/:app/access", {
      params: app,
      success: AppAccess,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.patch("shareApp", "/api/organizations/:organization/apps/:app/access", {
      params: app,
      payload: Schema.Struct({ audience: AppAudience, revision: AccessRevision }),
      success: AppAccess,
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("account", "/api/organizations/:organization/accounts/:account/access", {
      params: account,
      success: AccountAccess,
      error: errors,
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.patch(
      "shareAccount",
      "/api/organizations/:organization/accounts/:account/access",
      {
        params: account,
        payload: Schema.Struct({ audience: SharedAudience, revision: AccessRevision }),
        success: AccountAccess,
        error: errors,
      },
    ).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
