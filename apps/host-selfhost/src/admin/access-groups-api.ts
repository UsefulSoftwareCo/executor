import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Self-host access-groups API — ADMIN-ONLY management of connection access
// groups, mounted beside the invite-code admin routes under /api/admin/*.
//
// Every route is gated by the shared `requireInstanceAdmin` (require-admin.ts),
// which authorizes against the INSTANCE's own organization — the same
// escalation defense the other admin planes use. Deliberately NOT part of the
// shared `ExecutorApi` (whose trust model is "any org member"). Enforcement
// lives in the executor core; these endpoints only edit the group rows.
//
// Browser-safe: schemas + the HttpApi value only (no server imports), so the
// web client can build a typed AtomHttpApi from it.
// ---------------------------------------------------------------------------

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

export const AccessGroupItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const AccessGroupMemberItem = Schema.Struct({
  groupId: Schema.String,
  /** The member's Better Auth `user.id` — the same principal id the subject
   *  table records. */
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

const ERRORS = [
  AccessGroupsError,
  AccessGroupsUnauthorized,
  AccessGroupsForbidden,
  AccessGroupsNotFound,
];

// Paths are `/admin/*` (no `/api`): the server mounts this on the same
// `/api`-prefixed router as the core API — symmetric with the invite plane.
export const AccessGroupsApi = HttpApiGroup.make("accessGroups")
  .add(
    HttpApiEndpoint.get("listGroups", "/admin/access-groups", {
      success: AccessGroupsResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("createGroup", "/admin/access-groups", {
      payload: GroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.post("renameGroup", "/admin/access-groups/:groupId", {
      params: GroupParams,
      payload: GroupNameBody,
      success: AccessGroupItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteGroup", "/admin/access-groups/:groupId", {
      params: GroupParams,
      success: SuccessResponse,
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
      payload: AddMemberBody,
      success: AccessGroupMemberItem,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeMember", "/admin/access-groups/:groupId/members/:subject", {
      params: MemberParams,
      success: SuccessResponse,
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
      success: SuccessResponse,
      error: ERRORS,
    }),
  )
  .add(
    HttpApiEndpoint.delete(
      "unrestrictConnection",
      "/admin/access-group-restrictions/:integration/:name",
      {
        params: RestrictionParams,
        success: SuccessResponse,
        error: ERRORS,
      },
    ),
  );

/** Standalone HttpApi wrapping the access-groups group — mounted server-side
 *  as an extension route layer, consumable by a typed web client. */
export const AccessGroupsHttpApi = HttpApi.make("executor-self-host-access-groups").add(
  AccessGroupsApi,
);
