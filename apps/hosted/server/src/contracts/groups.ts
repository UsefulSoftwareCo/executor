/** Hosted organization groups. Account and app grants are separate later capabilities. */
import { Context, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";
import { Principal } from "./auth.ts";

/** Stable group identity, always looked up within an explicit organization. */
export const GroupId = Schema.NonEmptyString.pipe(Schema.brand("GroupId"));
export type GroupId = typeof GroupId.Type;
/** A current organization membership, not an invitation or arbitrary user ID. */
export const GroupMemberId = Schema.NonEmptyString.pipe(Schema.brand("GroupMemberId"));
export type GroupMemberId = typeof GroupMemberId.Type;
/** Opaque version used to prevent overwriting another administrator's changes. */
export const GroupRevision = Schema.NonEmptyString.pipe(Schema.brand("GroupRevision"));
/** Group labels are bounded and normalized by callers before submission. */
export const GroupName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter((value) => value === value.trim()),
);
/** One atomic edit saves both metadata and the complete selected membership. */
export const GroupInput = Schema.Struct({
  name: GroupName,
  description: Schema.String.check(Schema.isMaxLength(240)),
  memberIds: Schema.Array(GroupMemberId).check(
    Schema.isMaxLength(10000),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
/** Public group projection contains no provider credentials or resource access rules. */
export const Group = Schema.Struct({ id: GroupId, revision: GroupRevision, ...GroupInput.fields });
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
export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()(
  "GroupNotFound",
  {},
  { httpApiStatus: 404 },
) {}
/** Safe conflicts preserve the user's draft; no partial edit is committed. */
export class GroupConflict extends Schema.TaggedError<GroupConflict>()(
  "GroupConflict",
  { reason: Schema.Literals(["changed", "name_taken", "members_changed"]) },
  { httpApiStatus: 409 },
) {}
/** Storage failures contain no raw database details. */
export class GroupsUnavailable extends Schema.TaggedError<GroupsUnavailable>()(
  "GroupsUnavailable",
  {},
  { httpApiStatus: 503 },
) {}
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
