/** Hosted organization groups. Account and app grants are separate later capabilities. */
import { Context, Effect, Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import type { SqlClient } from "effect/sql";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { Principal } from "./auth.ts";

/**
 * Identifiers are opaque text that reaches storage as a lookup key. Control characters never occur
 * in one, and a NUL cannot be stored at all, so the database would fail the request with an
 * unavailable error instead of a bad request.
 */
const OpaqueId = Schema.NonEmptyString.check(Schema.isPattern(/^[^\p{Cc}]*$/u));
/** Stable group identity, always looked up within an explicit organization. */
export const GroupId = OpaqueId.pipe(Schema.brand("GroupId"));
export type GroupId = typeof GroupId.Type;
/** A current organization membership, not an invitation or arbitrary user ID. */
export const GroupMemberId = OpaqueId.pipe(Schema.brand("GroupMemberId"));
export type GroupMemberId = typeof GroupMemberId.Type;
/** Opaque version used to prevent overwriting another administrator's changes. */
export const GroupRevision = OpaqueId.pipe(Schema.brand("GroupRevision"));
/** What a saved group's name must still satisfy to be returned. Never narrower than past writes. */
const SavedGroupName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter((value) => value === value.trim()),
);
/**
 * Group labels are bounded and normalized by callers before submission. A new name is one line
 * with a visible character: control characters (a NUL cannot be stored) and line separators are
 * refused, and so is a name of only invisible characters, which would list as blank.
 */
export const GroupName = SavedGroupName.check(
  Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u),
  Schema.isPattern(/[^\s\p{Cc}\p{Cf}]/u),
);
const SavedGroupDescription = Schema.String.check(Schema.isMaxLength(240));
/**
 * A new description may span lines, so tab and line breaks are allowed, but not the other control
 * characters, and never NUL.
 */
export const GroupDescription = SavedGroupDescription.check(
  Schema.isPattern(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/u),
);
const GroupMembers = Schema.Array(GroupMemberId).check(
  Schema.isMaxLength(10000),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length),
);
/** One atomic edit saves both metadata and the complete selected membership. */
export const GroupInput = Schema.Struct({
  name: GroupName,
  description: GroupDescription,
  memberIds: GroupMembers,
});
/**
 * Public group projection contains no provider credentials or resource access rules. It reads
 * names and descriptions with the rules earlier writes followed, so groups saved before
 * `GroupInput` grew stricter are still returned.
 */
export const Group = Schema.Struct({
  id: GroupId,
  revision: GroupRevision,
  name: SavedGroupName,
  description: SavedGroupDescription,
  memberIds: GroupMembers,
});
export type Group = typeof Group.Type;
/** Admins receive eligible organization members; members see people in their visible groups. */
export const GroupMember = Schema.Struct({
  id: GroupMemberId,
  userId: Principal.fields.userId,
  name: Schema.String,
  email: Schema.String,
});
export type GroupMember = typeof GroupMember.Type;
/** One request supplies authorized groups, their members, and server-derived management authority. */
export const GroupsView = Schema.Struct({
  groups: Schema.Array(Group),
  members: Schema.Array(GroupMember),
  canManage: Schema.Boolean,
});
/** The group is missing or unavailable to this viewer; inaccessible group IDs disclose nothing. */
export const GroupNotFound = ApiError.define({
  tag: "GroupNotFound",
  status: 404,
  message: "This group does not exist, or you are not a member of it.",
});
export type GroupNotFound = typeof GroupNotFound.Type;
const groupConflicts = {
  changed: "The group changed since it was read. Read it again and reapply the edit.",
  name_taken: "Another group in this organization already uses this name.",
  members_changed:
    "The group's members changed since they were read. Read them again and reapply the edit.",
} as const;
/** Safe conflicts preserve the user's draft; no partial edit is committed. */
export const GroupConflict = ApiError.define({
  tag: "GroupConflict",
  status: 409,
  fields: { reason: Schema.Literals(["changed", "name_taken", "members_changed"]) },
  message: ({ reason }) => groupConflicts[reason],
  recorded: ({ reason }) => groupConflicts[reason],
});
export type GroupConflict = typeof GroupConflict.Type;
/** Storage failures contain no raw database details. */
export const GroupsUnavailable = ApiError.define({
  tag: "GroupsUnavailable",
  status: 503,
  message: "Executor could not read or save groups. Try again.",
});
export type GroupsUnavailable = typeof GroupsUnavailable.Type;
/** Lazy request-owned database acquisition; an isolate must never retain a live client. */
export class GroupDatabase extends Context.Service<
  GroupDatabase,
  Effect.Effect<SqlClient.SqlClient, GroupsUnavailable>
>()("hosted/GroupDatabase") {}
const organization = { organization: OrganizationReference };
const group = { ...organization, group: GroupId };
const errors = [OrganizationForbidden, GroupsUnavailable, GroupConflict, GroupNotFound];
/** Reads require membership; handlers also require a current admin role for every write. */
export const HostedGroups = HttpApiGroup.make("groups")
  .add(
    HttpApiEndpoint.get("list", "/api/organizations/:organization/groups", {
      params: organization,
      success: GroupsView,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/api/organizations/:organization/groups/:group", {
      params: group,
      success: Group,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/api/organizations/:organization/groups", {
      params: organization,
      payload: GroupInput,
      success: Group,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/api/organizations/:organization/groups/:group", {
      params: group,
      payload: Schema.Struct({ ...GroupInput.fields, revision: GroupRevision }),
      success: Group,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/api/organizations/:organization/groups/:group", {
      params: group,
      payload: Schema.Struct({ revision: GroupRevision }),
      success: Schema.Struct({ id: GroupId }),
      error: errors,
    }),
  )
  .middleware(RequireOrganization);
