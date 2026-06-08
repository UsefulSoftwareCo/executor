import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  IntegrationSlug,
  InternalError,
  IntegrationAlreadyExistsError,
} from "@executor-js/sdk/shared";

import { McpConnectionError, McpToolDiscoveryError } from "../sdk/errors";
import { McpAuthTemplate, McpIntegrationConfig } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const SlugParams = { slug: IntegrationSlug };

const StringMap = Schema.Record(Schema.String, Schema.String);

// ---------------------------------------------------------------------------
// Add server — discriminated union on transport. An MCP server is registered
// as an integration; connections (credentials) are created separately through
// the core connections / oauth surface.
// ---------------------------------------------------------------------------

const AddRemoteServerPayload = Schema.Struct({
  transport: Schema.optional(Schema.Literal("remote")),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literals(["streamable-http", "sse", "auto"])),
  slug: Schema.optional(Schema.String),
  queryParams: Schema.optional(StringMap),
  headers: Schema.optional(StringMap),
  auth: Schema.optional(McpAuthTemplate),
});

const AddStdioServerPayload = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringMap),
  cwd: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

const AddServerPayload = Schema.Union([AddRemoteServerPayload, AddStdioServerPayload]);

const ProbeEndpointPayload = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(StringMap),
  queryParams: Schema.optional(StringMap),
});

const ProbeEndpointResponse = Schema.Struct({
  connected: Schema.Boolean,
  requiresAuthentication: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  slug: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddServerResponse = Schema.Struct({
  slug: Schema.String,
});

const RemoveServerResponse = Schema.Struct({
  removed: Schema.Boolean,
});

const GetServerResponse = Schema.NullOr(
  Schema.Struct({
    slug: IntegrationSlug,
    description: Schema.String,
    kind: Schema.String,
    canRemove: Schema.Boolean,
    canRefresh: Schema.Boolean,
    config: McpIntegrationConfig,
  }),
);

// ---------------------------------------------------------------------------
// Group
//
// Integrations are tenant-level (no scope segment); plugin domain errors carry
// their own `HttpApiSchema` status (4xx). `InternalError` is the shared opaque
// 500 translated at the HTTP edge.
// ---------------------------------------------------------------------------

export const McpGroup = HttpApiGroup.make("mcp")
  .add(
    HttpApiEndpoint.post("probeEndpoint", "/mcp/probe", {
      payload: ProbeEndpointPayload,
      success: ProbeEndpointResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.post("addServer", "/mcp/servers", {
      payload: AddServerPayload,
      success: AddServerResponse,
      error: [
        InternalError,
        McpConnectionError,
        McpToolDiscoveryError,
        IntegrationAlreadyExistsError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeServer", "/mcp/servers/:slug", {
      params: SlugParams,
      success: RemoveServerResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getServer", "/mcp/servers/:slug", {
      params: SlugParams,
      success: GetServerResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  );
