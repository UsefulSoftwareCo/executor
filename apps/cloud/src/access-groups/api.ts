import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { WorkOSError } from "../auth/errors";

// ---------------------------------------------------------------------------
// Cloud access-groups API — ADMIN-ONLY management of connection access groups.
//
// Deliberately a cloud-local group behind the org-session auth middleware and
// a per-endpoint WorkOS admin-role gate, NOT part of the shared `ExecutorApi`:
// that surface's trust model is "any org member", and group management (who
// may see which org connection) must not ride it. Enforcement itself lives in
// the executor core — these endpoints only edit the group rows; a restricted
// connection is already invisible/uninvokable for non-members everywhere.
// ---------------------------------------------------------------------------

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

/** Rule violations from the engine (empty name, group still referenced,
 *  unknown group) and storage failures, rendered with the engine's message —
 *  this is an admin plane, where the message IS the actionable content. */
export class AccessGroupsError extends Schema.TaggedErrorClass<AccessGroupsError>()(
  "AccessGroupsError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const AccessGroupItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const AccessGroupMemberItem = Schema.Struct({
  groupId: Schema.String,
  /** The member's WorkOS account id (`user_...`) — the same principal id the
   *  subject table records. */
  subject: Schema.String,
  createdAt: Schema.String,
});

export const AccessGroupRestrictionItem = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
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

export const SuccessResponse = Schema.Struct({
  success: Schema.Boolean,
});

export const GroupNameBody = Schema.Struct({
  name: Schema.String,
});

export const AddMemberBody = Schema.Struct({
  subject: Schema.String,
});

export const RestrictConnectionBody = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
  group: Schema.String,
});

const GroupParams = { groupId: Schema.String };
const MemberParams = { groupId: Schema.String, subject: Schema.String };
const RestrictionParams = { integration: Schema.String, name: Schema.String };

const ERRORS = [WorkOSError, AccessGroupsForbidden, AccessGroupsNotFound, AccessGroupsError];

export class AccessGroupsApi extends HttpApiGroup.make("accessGroups")
  .add(
    HttpApiEndpoint.get("listGroups", "/org/access-groups", {
      success: AccessGroupsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("createGroup", "/org/access-groups", {
      payload: GroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("renameGroup", "/org/access-groups/:groupId", {
      params: GroupParams,
      payload: GroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteGroup", "/org/access-groups/:groupId", {
      params: GroupParams,
      success: SuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.get("listMembers", "/org/access-groups/:groupId/members", {
      params: GroupParams,
      success: AccessGroupMembersResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("addMember", "/org/access-groups/:groupId/members", {
      params: GroupParams,
      payload: AddMemberBody,
      success: AccessGroupMemberItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/org/access-groups/:groupId/members/:subject", {
      params: MemberParams,
      success: SuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRestrictions", "/org/access-group-restrictions", {
      success: AccessGroupRestrictionsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("restrictConnection", "/org/access-group-restrictions", {
      payload: RestrictConnectionBody,
      success: SuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "unrestrictConnection",
      "/org/access-group-restrictions/:integration/:name",
      {
        params: RestrictionParams,
        success: SuccessResponse,
        error: ERRORS,
      },
    ),
  ) {}

/** Access-groups API with org-level auth supplied by the router middleware in
 *  ../org/auth-middleware.ts (same mounting as the org domains group). */
export const AccessGroupsHttpApi = HttpApi.make("accessGroups").add(AccessGroupsApi);
