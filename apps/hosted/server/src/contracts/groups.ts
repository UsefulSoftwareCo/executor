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

export const GroupId = Schema.NonEmptyString.pipe(Schema.brand("GroupId"));
export type GroupId = typeof GroupId.Type;
export const GroupMemberId = Schema.NonEmptyString.pipe(Schema.brand("GroupMemberId"));
export type GroupMemberId = typeof GroupMemberId.Type;
export const GroupRevision = Schema.NonEmptyString.pipe(Schema.brand("GroupRevision"));
export const GroupName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter((value) => value === value.trim()),
);
export const GroupInput = Schema.Struct({
  name: GroupName,
  description: Schema.String.check(Schema.isMaxLength(240)),
  memberIds: Schema.Array(GroupMemberId).check(
    Schema.isMaxLength(10000),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
export const Group = Schema.Struct({ id: GroupId, revision: GroupRevision, ...GroupInput.fields });
export type Group = typeof Group.Type;
export const GroupMember = Schema.Struct({
  id: GroupMemberId,
  userId: Principal.fields.userId,
  name: Schema.String,
  email: Schema.String,
  image: Schema.NullOr(Schema.String),
});
export type GroupMember = typeof GroupMember.Type;
export const GroupsView = Schema.Struct({
  groups: Schema.Array(Group),
  members: Schema.Array(GroupMember),
  canManage: Schema.Boolean,
});
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
export const GroupConflict = ApiError.define({
  tag: "GroupConflict",
  status: 409,
  fields: { reason: Schema.Literals(["changed", "name_taken", "members_changed"]) },
  message: ({ reason }) => groupConflicts[reason],
  recorded: ({ reason }) => groupConflicts[reason],
});
export type GroupConflict = typeof GroupConflict.Type;
export const GroupsUnavailable = ApiError.define({
  tag: "GroupsUnavailable",
  status: 503,
  message: "Executor could not read or save groups. Try again.",
});
export type GroupsUnavailable = typeof GroupsUnavailable.Type;
export class GroupDatabase extends Context.Service<
  GroupDatabase,
  Effect.Effect<SqlClient.SqlClient, GroupsUnavailable>
>()("hosted/GroupDatabase") {}
const organization = { organization: OrganizationReference };
const group = { ...organization, group: GroupId };
const errors = [OrganizationForbidden, GroupsUnavailable, GroupConflict, GroupNotFound];
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
