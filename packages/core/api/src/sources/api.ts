import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  InternalError,
  CredentialBindingRef,
  RemoveSourceCredentialBindingInput,
  ScopeId,
  SetSourceCredentialBindingInput,
  SourceRemovalNotAllowedError,
  ReplaceSourceCredentialBindingsInput,
  ToolId,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const SourceParams = { scopeId: ScopeId, sourceId: Schema.String };
const SourceBindingParams = {
  scopeId: ScopeId,
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
};

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const SourceResponse = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.optional(ScopeId),
  name: Schema.String,
  kind: Schema.String,
  url: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.Boolean),
  canRemove: Schema.optional(Schema.Boolean),
  canRefresh: Schema.optional(Schema.Boolean),
  canEdit: Schema.optional(Schema.Boolean),
  connectionIds: Schema.optional(Schema.Array(Schema.String)),
});

const SourceRemoveResponse = Schema.Struct({
  removed: Schema.Boolean,
});

const SourceRefreshResponse = Schema.Struct({
  refreshed: Schema.Boolean,
});

const ToolMetadataResponse = Schema.Struct({
  id: ToolId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
  /** Plugin-derived default approval annotation. Surfaces in the UI as
   *  the "default" policy when no user `tool_policy` rule matches. */
  requiresApproval: Schema.optional(Schema.Boolean),
  approvalDescription: Schema.optional(Schema.String),
});

const DetectRequest = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_048)),
});

const ConfigureSourceRequest = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String,
    scope: ScopeId,
  }),
  scope: ScopeId,
  type: Schema.optional(Schema.String),
  config: Schema.Unknown,
});

const DetectResultResponse = Schema.Struct({
  kind: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  endpoint: Schema.String,
  name: Schema.String,
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const SourceRemovalNotAllowed = SourceRemovalNotAllowedError.annotate({ httpApiStatus: 409 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const SourcesApi = HttpApiGroup.make("sources")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/sources", {
      params: ScopeParams,
      success: Schema.Array(SourceResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/sources/:sourceId", {
      params: SourceParams,
      success: SourceRemoveResponse,
      error: [InternalError, SourceRemovalNotAllowed],
    }),
  )
  .add(
    HttpApiEndpoint.post("refresh", "/scopes/:scopeId/sources/:sourceId/refresh", {
      params: SourceParams,
      success: SourceRefreshResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("tools", "/scopes/:scopeId/sources/:sourceId/tools", {
      params: SourceParams,
      success: Schema.Array(ToolMetadataResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("detect", "/scopes/:scopeId/sources/detect", {
      params: ScopeParams,
      payload: DetectRequest,
      success: Schema.Array(DetectResultResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("configure", "/scopes/:scopeId/sources/configure", {
      params: ScopeParams,
      payload: ConfigureSourceRequest,
      success: Schema.Unknown,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "listBindings",
      "/scopes/:scopeId/sources/:sourceId/base/:sourceScopeId/bindings",
      {
        params: SourceBindingParams,
        success: Schema.Array(CredentialBindingRef),
        error: InternalError,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("setBinding", "/scopes/:scopeId/source-bindings", {
      params: ScopeParams,
      payload: SetSourceCredentialBindingInput,
      success: CredentialBindingRef,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("removeBinding", "/scopes/:scopeId/source-bindings/remove", {
      params: ScopeParams,
      payload: RemoveSourceCredentialBindingInput,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("replaceBindings", "/scopes/:scopeId/source-bindings/replace", {
      params: ScopeParams,
      payload: ReplaceSourceCredentialBindingsInput,
      success: Schema.Array(CredentialBindingRef),
      error: InternalError,
    }),
  );
