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
  family: Schema.optional(Schema.String),
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
  family: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Declare the secret env vars this server needs, by name. Their values are
   *  supplied as the connection's secrets (the connect step), not here. */
  envVars: Schema.optional(Schema.Array(Schema.String)),
  /** One-shot secret env values (programmatic). The UI sends `envVars`. */
  env: Schema.optional(StringMap),
  cwd: Schema.optional(Schema.String),
  /** Protocol negotiation at connect: `auto` probes `server/discover` (spec
   *  2026-07-28) for modern-only servers; default is the legacy `initialize`
   *  handshake. */
  versionNegotiation: Schema.optional(Schema.Literals(["legacy", "auto"])),
  /** Reach the server through the Codex app-server bridge: the command spawns
   *  `codex app-server` and `server` names the MCP server inside Codex. */
  appServer: Schema.optional(Schema.Struct({ server: Schema.String })),
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

// Locally installed Codex plugins with stdio MCP servers, reported by the
// server-side scanner as one-click stdio presets. `available: false` entries
// render with `setupHint` instead of an add action.
const CodexPluginEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  available: Schema.Boolean,
  slug: Schema.String,
  source: Schema.Literals(["curated", "scanned"]),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(StringMap),
  /** Present on curated entries: add through the Codex app-server bridge,
   *  calling tools on this named server inside Codex. */
  appServer: Schema.optional(Schema.Struct({ server: Schema.String })),
  setupHint: Schema.optional(Schema.String),
  /** The plugin's own icon from its local install, as a data URI. */
  icon: Schema.optional(Schema.String),
  /** The plugin's own display metadata from its local manifest. */
  displayName: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const ListCodexPluginsResponse = Schema.Struct({
  plugins: Schema.Array(CodexPluginEntrySchema),
});

// One plugin's icon by preset id, for `executor:`-scheme icon resolution
// (static catalog presets cannot embed a machine-local file; an <img> cannot
// carry the bearer header, so the client fetches this and renders the data
// URI).
const CodexPluginIconResponse = Schema.Struct({
  icon: Schema.NullOr(Schema.String),
});

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
  )
  .add(
    HttpApiEndpoint.get("listCodexPlugins", "/mcp/codex-plugins", {
      success: ListCodexPluginsResponse,
      error: [InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getCodexPluginIcon", "/mcp/codex-plugins/:id/icon", {
      params: { id: Schema.String },
      success: CodexPluginIconResponse,
      error: [InternalError],
    }),
  );
