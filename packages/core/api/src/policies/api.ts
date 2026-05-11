import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { PolicyId, ScopeId, ToolPolicyActionSchema } from "@executor-js/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const PolicyParams = { scopeId: ScopeId, policyId: PolicyId };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const ToolPolicyResponse = Schema.Struct({
  id: PolicyId,
  scopeId: ScopeId,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const CreateToolPolicyPayload = Schema.Struct({
  targetScope: ScopeId,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.String),
});

const UpdateToolPolicyPayload = Schema.Struct({
  targetScope: ScopeId,
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const PoliciesApi = HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/policies", {
      params: ScopeParams,
      success: Schema.Array(ToolPolicyResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/scopes/:scopeId/policies", {
      params: ScopeParams,
      payload: CreateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/scopes/:scopeId/policies/:policyId", {
      params: PolicyParams,
      payload: UpdateToolPolicyPayload,
      success: ToolPolicyResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/policies/:policyId", {
      params: PolicyParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }),
  );
