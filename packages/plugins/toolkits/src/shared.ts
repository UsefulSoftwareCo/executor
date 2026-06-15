// ---------------------------------------------------------------------------
// @executor-js/plugin-toolkits/shared
//
// Schemas + the HttpApiGroup shared between server and client. A "toolkit" is a
// named slice of the caller's connections (each off/read/full), scoped to the
// workspace (org-owned connections only) or the caller personally (org + own).
//
// No React or Node imports here — server and client both import this.
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { IntegrationSlug, InternalError } from "@executor-js/sdk/shared";

// off = invisible, read = read-only tools only, full = every tool.
export const ToolkitAccess = Schema.Literals(["off", "read", "full"]);
export type ToolkitAccess = typeof ToolkitAccess.Type;

// workspace = org-owned (visible to every org member); personal = the caller's own.
export const ToolkitScope = Schema.Literals(["workspace", "personal"]);
export type ToolkitScope = typeof ToolkitScope.Type;

// One connection in a toolkit's slice. `connection` is a pinned account name,
// or "*" to track every connection of the integration.
export const ToolkitConnectionEntry = Schema.Struct({
  integration: IntegrationSlug,
  connection: Schema.String,
  access: ToolkitAccess,
  note: Schema.optional(Schema.String),
});
export type ToolkitConnectionEntry = typeof ToolkitConnectionEntry.Type;

// off/read/full is the per-connection access mode; policies are pattern rules
// layered on top. v1 enforces `block` (the tool is excluded); `approve` /
// `require_approval` are persisted + briefed (org approval policies still apply).
export const ToolkitPolicyAction = Schema.Literals(["approve", "require_approval", "block"]);
export type ToolkitPolicyAction = typeof ToolkitPolicyAction.Type;

export const ToolkitPolicy = Schema.Struct({
  pattern: Schema.String,
  action: ToolkitPolicyAction,
});
export type ToolkitPolicy = typeof ToolkitPolicy.Type;

export const ToolkitView = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  scope: ToolkitScope,
  inheritOrgPolicies: Schema.Boolean,
  briefing: Schema.NullOr(Schema.String),
  connections: Schema.Array(ToolkitConnectionEntry),
  policies: Schema.Array(ToolkitPolicy),
});
export type ToolkitView = typeof ToolkitView.Type;

export const CreateToolkitPayload = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  scope: ToolkitScope,
  inheritOrgPolicies: Schema.optional(Schema.Boolean),
  briefing: Schema.optional(Schema.String),
  connections: Schema.optional(Schema.Array(ToolkitConnectionEntry)),
  policies: Schema.optional(Schema.Array(ToolkitPolicy)),
});
export type CreateToolkitPayload = typeof CreateToolkitPayload.Type;

export const UpdateToolkitPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  briefing: Schema.optional(Schema.NullOr(Schema.String)),
  inheritOrgPolicies: Schema.optional(Schema.Boolean),
  connections: Schema.optional(Schema.Array(ToolkitConnectionEntry)),
  policies: Schema.optional(Schema.Array(ToolkitPolicy)),
});
export type UpdateToolkitPayload = typeof UpdateToolkitPayload.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ToolkitNotFound extends Schema.TaggedErrorClass<ToolkitNotFound>()("ToolkitNotFound", {
  id: Schema.String,
}) {}

export class ToolkitForbidden extends Schema.TaggedErrorClass<ToolkitForbidden>()(
  "ToolkitForbidden",
  {
    reason: Schema.String,
  },
) {}

const NotFound = ToolkitNotFound.annotate({ httpApiStatus: 404 });
const Forbidden = ToolkitForbidden.annotate({ httpApiStatus: 403 });

const IdParams = { id: Schema.String };

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ToolkitsApi = HttpApiGroup.make("toolkits")
  .add(
    HttpApiEndpoint.get("list", "/toolkits", {
      success: Schema.Array(ToolkitView),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/toolkits", {
      payload: CreateToolkitPayload,
      success: ToolkitView,
      error: [InternalError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/toolkits/:id", {
      params: IdParams,
      success: ToolkitView,
      error: [InternalError, NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/toolkits/:id", {
      params: IdParams,
      payload: UpdateToolkitPayload,
      success: ToolkitView,
      error: [InternalError, NotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/toolkits/:id", {
      params: IdParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, NotFound],
    }),
  );
