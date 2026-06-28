import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { InternalError, Owner, ToolPolicyActionSchema } from "@executor-js/sdk/shared";

export class ToolkitError extends Schema.TaggedErrorClass<ToolkitError>()(
  "ToolkitError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

const ToolkitParams = {
  toolkitId: Schema.String,
};

const ToolkitPolicyParams = {
  toolkitId: Schema.String,
  policyId: Schema.String,
};

const ToolkitConnectionParams = {
  toolkitId: Schema.String,
  connectionId: Schema.String,
};

export const ToolkitResponse = Schema.Struct({
  id: Schema.String,
  owner: Owner,
  slug: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ToolkitResponse = typeof ToolkitResponse.Type;

export const ToolkitPolicyResponse = Schema.Struct({
  id: Schema.String,
  toolkitId: Schema.String,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ToolkitPolicyResponse = typeof ToolkitPolicyResponse.Type;

export const ToolkitConnectionResponse = Schema.Struct({
  id: Schema.String,
  toolkitId: Schema.String,
  pattern: Schema.String,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ToolkitConnectionResponse = typeof ToolkitConnectionResponse.Type;

const CreateToolkitPayload = Schema.Struct({
  owner: Owner,
  name: Schema.String,
  slug: Schema.optional(Schema.String),
});

const UpdateToolkitPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

const CreateToolkitPolicyPayload = Schema.Struct({
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.String),
});

const UpdateToolkitPolicyPayload = Schema.Struct({
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.String),
});

const CreateToolkitConnectionPayload = Schema.Struct({
  pattern: Schema.String,
  position: Schema.optional(Schema.String),
});

const ToolkitErrors = [InternalError, ToolkitError] as const;

export const ToolkitsApi = HttpApiGroup.make("toolkits")
  .add(
    HttpApiEndpoint.get("list", "/toolkits", {
      success: Schema.Struct({ toolkits: Schema.Array(ToolkitResponse) }),
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/toolkits", {
      payload: CreateToolkitPayload,
      success: ToolkitResponse,
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/toolkits/:toolkitId", {
      params: ToolkitParams,
      payload: UpdateToolkitPayload,
      success: ToolkitResponse,
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/toolkits/:toolkitId", {
      params: ToolkitParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listPolicies", "/toolkits/:toolkitId/policies", {
      params: ToolkitParams,
      success: Schema.Struct({ policies: Schema.Array(ToolkitPolicyResponse) }),
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createPolicy", "/toolkits/:toolkitId/policies", {
      params: ToolkitParams,
      payload: CreateToolkitPolicyPayload,
      success: ToolkitPolicyResponse,
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updatePolicy", "/toolkits/:toolkitId/policies/:policyId", {
      params: ToolkitPolicyParams,
      payload: UpdateToolkitPolicyPayload,
      success: ToolkitPolicyResponse,
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removePolicy", "/toolkits/:toolkitId/policies/:policyId", {
      params: ToolkitPolicyParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listConnections", "/toolkits/:toolkitId/connections", {
      params: ToolkitParams,
      success: Schema.Struct({ connections: Schema.Array(ToolkitConnectionResponse) }),
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createConnection", "/toolkits/:toolkitId/connections", {
      params: ToolkitParams,
      payload: CreateToolkitConnectionPayload,
      success: ToolkitConnectionResponse,
      error: ToolkitErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeConnection", "/toolkits/:toolkitId/connections/:connectionId", {
      params: ToolkitConnectionParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: ToolkitErrors,
    }),
  );
