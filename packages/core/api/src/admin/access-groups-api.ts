// ---------------------------------------------------------------------------
// Access Groups HTTP API — the ADMIN-ONLY management surface for connection /
// toolkit access groups, served identically by both hosts at `/admin/*`
// (mirroring the admin-users plane), so ONE shared client works everywhere.
//
// Deliberately NOT part of the shared `ExecutorApi`: that surface's trust
// model is "any org member", and group management (who may see which org
// connection) must not ride it. Auth is applied by each host's own admin
// middleware (cloud: WorkOS admin-role session; self-host: a Better Auth
// owner/admin), same as the admin-users plane — this contract carries no
// provider-specific auth scheme.
//
// Enforcement itself lives in the executor core (a restricted connection or
// toolkit is invisible and uninvokable for non-members, with no existence
// oracle); these endpoints only edit the group rows.
// ---------------------------------------------------------------------------

import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Rule violations from the engine (empty name, group still referenced,
 *  unknown group/toolkit) and storage failures, rendered with the engine's
 *  message — this is an admin plane, where the message IS the actionable
 *  content. */
export class AccessGroupsError extends Schema.TaggedErrorClass<AccessGroupsError>()(
  "AccessGroupsError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class AccessGroupsUnauthorized extends Schema.TaggedErrorClass<AccessGroupsUnauthorized>()(
  "AccessGroupsUnauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AccessGroupsForbidden extends Schema.TaggedErrorClass<AccessGroupsForbidden>()(
  "AccessGroupsForbidden",
  {},
  { httpApiStatus: 403 },
) {}

export class AccessGroupsNotFound extends Schema.TaggedErrorClass<AccessGroupsNotFound>()(
  "AccessGroupsNotFound",
  {},
  { httpApiStatus: 404 },
) {}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export const AccessGroupItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const AccessGroupMemberItem = Schema.Struct({
  groupId: Schema.String,
  /** The member's host-auth principal id (cloud: the WorkOS `user_...`;
   *  self-host: the Better Auth `user.id`) — the same id `/admin/users`
   *  reports as `externalId` and `/account/members` reports as the account
   *  id. Opaque; the console joins it to a display identity client-side. */
  subject: Schema.String,
  createdAt: Schema.String,
});

export const AccessGroupRestrictionItem = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
  group: Schema.String,
});

export const ToolkitRestrictionItem = Schema.Struct({
  toolkitId: Schema.String,
  slug: Schema.String,
  group: Schema.String,
});

export const AccessGroupsResponse = Schema.Struct({
  groups: Schema.Array(AccessGroupItem),
});

export const AccessGroupMembersResponse = Schema.Struct({
  members: Schema.Array(AccessGroupMemberItem),
});

export const AccessGroupRestrictionsResponse = Schema.Struct({
  restrictions: Schema.Array(AccessGroupRestrictionItem),
});

export const ToolkitRestrictionsResponse = Schema.Struct({
  restrictions: Schema.Array(ToolkitRestrictionItem),
});

export const AccessGroupsSuccessResponse = Schema.Struct({
  success: Schema.Boolean,
});

export const AccessGroupNameBody = Schema.Struct({
  name: Schema.String,
});

export const AccessGroupAddMemberBody = Schema.Struct({
  subject: Schema.String,
});

export const RestrictConnectionBody = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
  group: Schema.String,
});

export const RestrictToolkitBody = Schema.Struct({
  toolkitId: Schema.String,
  group: Schema.String,
});

const GroupParams = { groupId: Schema.String };
const MemberParams = { groupId: Schema.String, subject: Schema.String };
const RestrictionParams = { integration: Schema.String, name: Schema.String };
const ToolkitParams = { toolkitId: Schema.String };

const ERRORS = [
  AccessGroupsError,
  AccessGroupsUnauthorized,
  AccessGroupsForbidden,
  AccessGroupsNotFound,
];

// Paths are `/admin/*` (no `/api`): each host mounts this on its
// `/api`-prefixed router and the client prepends the API base — symmetric
// with the admin-users plane.
export class AccessGroupsApi extends HttpApiGroup.make("accessGroups")
  .add(
    HttpApiEndpoint.get("listGroups", "/admin/access-groups", {
      success: AccessGroupsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("createGroup", "/admin/access-groups", {
      payload: AccessGroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("renameGroup", "/admin/access-groups/:groupId", {
      params: GroupParams,
      payload: AccessGroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteGroup", "/admin/access-groups/:groupId", {
      params: GroupParams,
      success: AccessGroupsSuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.get("listMembers", "/admin/access-groups/:groupId/members", {
      params: GroupParams,
      success: AccessGroupMembersResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("addMember", "/admin/access-groups/:groupId/members", {
      params: GroupParams,
      payload: AccessGroupAddMemberBody,
      success: AccessGroupMemberItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/admin/access-groups/:groupId/members/:subject", {
      params: MemberParams,
      success: AccessGroupsSuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRestrictions", "/admin/access-group-restrictions", {
      success: AccessGroupRestrictionsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("restrictConnection", "/admin/access-group-restrictions", {
      payload: RestrictConnectionBody,
      success: AccessGroupsSuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "unrestrictConnection",
      "/admin/access-group-restrictions/:integration/:name",
      {
        params: RestrictionParams,
        success: AccessGroupsSuccessResponse,
        error: ERRORS,
      },
    ),
  )
  .add(
    HttpApiEndpoint.get("listToolkitRestrictions", "/admin/access-group-toolkit-restrictions", {
      success: ToolkitRestrictionsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("restrictToolkit", "/admin/access-group-toolkit-restrictions", {
      payload: RestrictToolkitBody,
      success: AccessGroupsSuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "unrestrictToolkit",
      "/admin/access-group-toolkit-restrictions/:toolkitId",
      {
        params: ToolkitParams,
        success: AccessGroupsSuccessResponse,
        error: ERRORS,
      },
    ),
  ) {}

/** Standalone HttpApi wrapping the group — mounted server-side by each host's
 *  admin layer, consumed client-side by the shared console client. */
export const AccessGroupsHttpApi = HttpApi.make("accessGroups").add(AccessGroupsApi);
