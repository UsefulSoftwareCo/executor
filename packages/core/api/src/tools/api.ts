import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, ScopeId, ToolId, ToolNotFoundError } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const PathParams = {
  scopeId: ScopeId,
  toolId: ToolId,
};

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ToolMetadataResponse = Schema.Struct({
  id: ToolId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
  requiresApproval: Schema.optional(Schema.Boolean),
});

const ToolSchemaResponse = Schema.Struct({
  id: ToolId,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ToolNotFound = ToolNotFoundError.annotate({ httpApiStatus: 404 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ToolsApi = HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/tools", {
      params: { scopeId: PathParams.scopeId },
      success: Schema.Array(ToolMetadataResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("schema", "/scopes/:scopeId/tools/:toolId/schema", {
      params: PathParams,
      success: ToolSchemaResponse,
      error: [InternalError, ToolNotFound],
    }),
  );
