import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  ScopeId,
  SecretId,
  SecretInUseError,
  SecretNotFoundError,
  SecretOwnedByConnectionError,
  SecretResolutionError,
  Usage,
} from "@executor-js/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const SecretParams = { scopeId: ScopeId, secretId: SecretId };

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const SecretRefResponse = Schema.Struct({
  id: SecretId,
  scopeId: ScopeId,
  name: Schema.String,
  provider: Schema.String,
  createdAt: Schema.Number,
});

const SecretStatusResponse = Schema.Struct({
  secretId: SecretId,
  status: Schema.Literals(["resolved", "missing"]),
});

const SetSecretPayload = Schema.Struct({
  id: SecretId,
  name: Schema.String,
  value: Schema.String,
  provider: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const SecretNotFound = SecretNotFoundError.annotate({ httpApiStatus: 404 });
const SecretResolution = SecretResolutionError.annotate({ httpApiStatus: 500 });
const SecretOwnedByConnection = SecretOwnedByConnectionError.annotate({ httpApiStatus: 409 });
const SecretInUse = SecretInUseError.annotate({ httpApiStatus: 409 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const SecretsApi = HttpApiGroup.make("secrets")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/secrets", {
      params: ScopeParams,
      success: Schema.Array(SecretRefResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAll", "/scopes/:scopeId/secrets/all", {
      params: ScopeParams,
      success: Schema.Array(SecretRefResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/scopes/:scopeId/secrets/:secretId/status", {
      params: SecretParams,
      success: SecretStatusResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("set", "/scopes/:scopeId/secrets", {
      params: ScopeParams,
      payload: SetSecretPayload,
      success: SecretRefResponse,
      error: [InternalError, SecretResolution],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/secrets/:secretId", {
      params: SecretParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, SecretNotFound, SecretOwnedByConnection, SecretInUse],
    }),
  )
  .add(
    HttpApiEndpoint.get("usages", "/scopes/:scopeId/secrets/:secretId/usages", {
      params: SecretParams,
      success: Schema.Array(Usage),
      error: InternalError,
    }),
  );
