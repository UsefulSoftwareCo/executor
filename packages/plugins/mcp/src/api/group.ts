import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  IntegrationSlug,
  InternalError,
  IntegrationAlreadyExistsError,
} from "@executor-js/sdk/shared";

import { McpConnectionError, McpToolDiscoveryError } from "../sdk/errors";
import {
  McpAuthMethod,
  McpAuthMethodInput,
  McpAuthShorthand,
  McpIntegrationConfig,
} from "../sdk/types";

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
  /** Agent-visible catalog description. Defaults to the display name. */
  description: Schema.optional(Schema.String),
  endpoint: Schema.String,
  remoteTransport: Schema.optional(Schema.Literals(["streamable-http", "sse", "auto"])),
  slug: Schema.optional(Schema.String),
  queryParams: Schema.optional(StringMap),
  headers: Schema.optional(StringMap),
  /** Declared auth methods a connection can be applied through. */
  authenticationTemplate: Schema.optional(Schema.Array(McpAuthMethodInput)),
  /** Single-method shorthand (legacy callers); ignored when
   *  `authenticationTemplate` is present. */
  auth: Schema.optional(McpAuthShorthand),
});

const AddStdioServerPayload = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Declare the secret env vars this server needs, by name. Their values are
   *  supplied as the connection's secrets (the connect step), not here. */
  envVars: Schema.optional(Schema.Array(Schema.String)),
  /** One-shot secret env values (programmatic). The UI sends `envVars`. */
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
  /** Server `instructions` from initialize — prefills the description field. */
  instructions: Schema.NullOr(Schema.String),
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

const ConfigureServerPayload = Schema.Struct({
  config: McpIntegrationConfig,
});

const ConfigureServerResponse = Schema.Struct({
  config: McpIntegrationConfig,
});

// The configureAuth payload/response — custom auth methods to merge-append
// onto the integration's `authenticationTemplate` (or `replace` the set).
// Mirrors the GraphQL/OpenAPI configure endpoints.
const ConfigureAuthPayload = Schema.Struct({
  authenticationTemplate: Schema.Array(McpAuthMethodInput),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});

const ConfigureAuthResponse = Schema.Struct({
  authenticationTemplate: Schema.Array(McpAuthMethod),
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
  )
  .add(
    HttpApiEndpoint.post("configureServer", "/mcp/servers/:slug/config", {
      params: SlugParams,
      payload: ConfigureServerPayload,
      success: ConfigureServerResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  )
  .add(
    HttpApiEndpoint.post("configureAuth", "/mcp/servers/:slug/auth", {
      params: SlugParams,
      payload: ConfigureAuthPayload,
      success: ConfigureAuthResponse,
      error: [InternalError, McpConnectionError, McpToolDiscoveryError],
    }),
  );
