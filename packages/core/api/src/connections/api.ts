import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  ConnectionId,
  ConnectionIdentityOverride,
  ConnectionInUseError,
  ConnectionNotFoundError,
  InternalError,
  ScopeId,
  Usage,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const ConnectionParams = { scopeId: ScopeId, connectionId: ConnectionId };

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ConnectionRefResponse = Schema.Struct({
  id: ConnectionId,
  scopeId: ScopeId,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  oauthScope: Schema.NullOr(Schema.String),
  identityOverride: Schema.NullOr(ConnectionIdentityOverride),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const ConnectionIdentityResponse = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "reauth_required", "error"]),
  source: Schema.Literals(["detected", "manual", "mixed", "unknown"]),
  subject: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.NullOr(Schema.Boolean),
  name: Schema.NullOr(Schema.String),
  username: Schema.NullOr(Schema.String),
  picture: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type ConnectionIdentityResponse = typeof ConnectionIdentityResponse.Type;

const UpdateConnectionIdentityPayload = Schema.Struct({
  identityOverride: Schema.NullOr(ConnectionIdentityOverride),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const ConnectionInUse = ConnectionInUseError.annotate({ httpApiStatus: 409 });
const ConnectionNotFound = ConnectionNotFoundError.annotate({ httpApiStatus: 404 });

export const ConnectionsApi = HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/connections", {
      params: ScopeParams,
      success: Schema.Array(ConnectionRefResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/connections/:connectionId", {
      params: ConnectionParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, ConnectionInUse],
    }),
  )
  .add(
    HttpApiEndpoint.get("usages", "/scopes/:scopeId/connections/:connectionId/usages", {
      params: ConnectionParams,
      success: Schema.Array(Usage),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("identity", "/scopes/:scopeId/connections/:connectionId/identity", {
      params: ConnectionParams,
      success: ConnectionIdentityResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateIdentity", "/scopes/:scopeId/connections/:connectionId/identity", {
      params: ConnectionParams,
      payload: UpdateConnectionIdentityPayload,
      success: ConnectionRefResponse,
      error: [InternalError, ConnectionNotFound],
    }),
  );
