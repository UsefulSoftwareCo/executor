// ---------------------------------------------------------------------------
// Policies HTTP API — owner-scoped tool policies (v2).
//
// Policies gate tool invocation by pattern + action, scoped to an owner
// (org | user) instead of a scope id. Org rules are the outer guardrail; the
// most restrictive matched action across owners wins.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, Owner, PolicyId, ToolPolicyActionSchema } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const PolicyParams = { policyId: PolicyId };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const ToolPolicyResponse = Schema.Struct({
  id: PolicyId,
  owner: Owner,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const CreateToolPolicyPayload = Schema.Struct({
  owner: Owner,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.String),
});

const UpdateToolPolicyPayload = Schema.Struct({
  owner: Owner,
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.String),
});

const RemoveToolPolicyPayload = Schema.Struct({
  owner: Owner,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const PoliciesApi = HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list", "/policies", {
      success: Schema.Array(ToolPolicyResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/policies", {
      payload: CreateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/policies/:policyId", {
      params: PolicyParams,
      payload: UpdateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/policies/:policyId", {
      params: PolicyParams,
      payload: RemoveToolPolicyPayload,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }),
  );
