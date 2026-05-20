import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, ScopeId, SecretBackedMap } from "@executor-js/sdk/shared";

import { McpConnectionError, McpToolDiscoveryError } from "../sdk/errors";
import { McpStoredSourceSchema } from "../sdk/stored-source";
import { McpConfiguredValueInput, McpConnectionAuthInput, McpCredentialInput } from "../sdk/types";
import { OAuth2SourceConfig } from "@executor-js/sdk/http-source";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const SourceParams = { scopeId: ScopeId, namespace: Schema.String };

const StringMap = Schema.Record(Schema.String, Schema.String);
// ---------------------------------------------------------------------------
// Add source — discriminated union on transport
// ---------------------------------------------------------------------------

const AddRemoteSourcePayload = Schema.Struct({
  transport: Schema.Literal("remote"),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literals(["streamable-http", "sse", "auto"])),
  namespace: Schema.optional(Schema.String),
  queryParams: Schema.optional(Schema.Record(Schema.String, McpConfiguredValueInput)),
  headers: Schema.optional(Schema.Record(Schema.String, McpConfiguredValueInput)),
  oauth2: Schema.optional(OAuth2SourceConfig),
  credentials: Schema.optional(
    Schema.Struct({
      scope: ScopeId,
      headers: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
      queryParams: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
      auth: Schema.optional(McpConnectionAuthInput),
    }),
  ),
});

const AddStdioSourcePayload = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringMap),
  cwd: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

const AddSourcePayload = Schema.Union([AddRemoteSourcePayload, AddStdioSourcePayload]);

const ProbeEndpointPayload = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
});

const ProbeEndpointResponse = Schema.Struct({
  connected: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  namespace: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

const NamespacePayload = Schema.Struct({
  namespace: Schema.String,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

const RefreshSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
});

const RemoveSourceResponse = Schema.Struct({
  removed: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (McpOAuthError etc.) are declared once at the group
// level via `.addError(...)` — every endpoint inherits them. The errors
// themselves carry their HTTP status via `HttpApiSchema.annotations`
// in errors.ts, so handlers just `return yield* ext.foo(...)` and the
// schema encodes whatever it gets.
//
// 5xx is handled at the API level: `CoreExecutorApi.addError(InternalError)`
// adds a single shared opaque-by-schema 500 surface to every endpoint in
// the entire API. Defects are captured + downgraded to it by an
// HttpApiBuilder middleware (see apps/cloud/src/observability.ts).
// No per-handler wrapping, no per-plugin InternalError.
// ---------------------------------------------------------------------------

export const McpGroup = HttpApiGroup.make("mcp")
  .add(
    HttpApiEndpoint.post("probeEndpoint", "/scopes/:scopeId/mcp/probe", {
      params: ScopeParams,
      payload: ProbeEndpointPayload,
      success: ProbeEndpointResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.post("addSource", "/scopes/:scopeId/mcp/sources", {
      params: ScopeParams,
      payload: AddSourcePayload,
      success: AddSourceResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.post("removeSource", "/scopes/:scopeId/mcp/sources/remove", {
      params: ScopeParams,
      payload: NamespacePayload,
      success: RemoveSourceResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.post("refreshSource", "/scopes/:scopeId/mcp/sources/refresh", {
      params: ScopeParams,
      payload: NamespacePayload,
      success: RefreshSourceResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSource", "/scopes/:scopeId/mcp/sources/:namespace", {
      params: SourceParams,
      success: Schema.NullOr(McpStoredSourceSchema),
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  );
// Errors declared once at the group level — every endpoint inherits.
// Plugin domain errors carry their own HttpApiSchema status (4xx);
// `InternalError` is the shared opaque 500 translated at the HTTP
// edge by `withCapture`. We only list errors an MCP *group*
// endpoint can surface: `McpInvocationError` is thrown inside
// `invokeTool` which is reached via the core `tools.invoke`
// endpoint, not any MCP-group endpoint, so it doesn't belong here.
// OAuth errors live on the shared `/oauth/*` group in `@executor-js/api`
// now — the MCP group only declares its own plugin-domain errors.
