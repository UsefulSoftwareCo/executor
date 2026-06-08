import { Effect, Option, Schema } from "effect";

// ---------------------------------------------------------------------------
// MCP plugin v2 data model.
//
// An MCP integration is one server. Its `config` blob (opaque to core, stored
// on the integration row) carries everything needed to dial the server plus an
// `auth` *template* describing how a connection's resolved value is applied to
// the request. A connection IS the credential: at execute time core resolves
// the connection's value through its provider (refreshing OAuth tokens), and
// the plugin renders it onto the request per the template (D11). The same path
// covers an API key bearer and an OAuth access token — both resolve to a value
// and render through their template.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transport / remote transport
// ---------------------------------------------------------------------------

export const McpRemoteTransport = Schema.Literals(["streamable-http", "sse", "auto"]);
export type McpRemoteTransport = typeof McpRemoteTransport.Type;

/** All transport types (used in the connector layer) */
export const McpTransport = Schema.Literals(["streamable-http", "sse", "stdio", "auto"]);
export type McpTransport = typeof McpTransport.Type;

// ---------------------------------------------------------------------------
// Auth template — how a connection's resolved value is applied to the request.
//
//   none   — no credential (open server)
//   header — render the value into a request header (e.g. `Authorization:
//            Bearer <value>`); `prefix` is prepended to the value
//   oauth2 — the value is an OAuth access token, applied as a Bearer header
//            via the MCP SDK's OAuthClientProvider
// ---------------------------------------------------------------------------

export const McpAuthTemplate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("oauth2") }),
]);
export type McpAuthTemplate = typeof McpAuthTemplate.Type;

// ---------------------------------------------------------------------------
// Integration config — the opaque blob stored on the integration row. A
// discriminated union on transport.
// ---------------------------------------------------------------------------

const StringMap = Schema.Record(Schema.String, Schema.String);

export const McpRemoteIntegrationConfig = Schema.Struct({
  transport: Schema.Literal("remote"),
  /** The MCP server endpoint URL */
  endpoint: Schema.String,
  /** Transport preference for this remote server */
  remoteTransport: McpRemoteTransport.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed("auto" as const)),
  ),
  /** Static query params appended to the endpoint URL (non-credential) */
  queryParams: Schema.optional(StringMap),
  /** Static headers sent on every request (non-credential) */
  headers: Schema.optional(StringMap),
  /** Auth template — how the connection's value is rendered onto requests */
  auth: McpAuthTemplate,
});
export type McpRemoteIntegrationConfig = typeof McpRemoteIntegrationConfig.Type;

export const McpStdioIntegrationConfig = Schema.Struct({
  transport: Schema.Literal("stdio"),
  /** The command to run */
  command: Schema.String,
  /** Arguments to the command */
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Environment variables */
  env: Schema.optional(StringMap),
  /** Working directory */
  cwd: Schema.optional(Schema.String),
});
export type McpStdioIntegrationConfig = typeof McpStdioIntegrationConfig.Type;

export const McpIntegrationConfig = Schema.Union([
  McpRemoteIntegrationConfig,
  McpStdioIntegrationConfig,
]);
export type McpIntegrationConfig = typeof McpIntegrationConfig.Type;

const decodeIntegrationConfig = Schema.decodeUnknownOption(McpIntegrationConfig);

/** Parse an opaque integration `config` blob into a typed MCP config, or null
 *  if it isn't this plugin's shape. */
export const parseMcpIntegrationConfig = (config: unknown): McpIntegrationConfig | null => {
  if (
    typeof config === "object" &&
    config !== null &&
    "transport" in config &&
    config.transport === "remote" &&
    !("auth" in config)
  ) {
    return Option.getOrNull(decodeIntegrationConfig({ ...config, auth: { kind: "none" } }));
  }
  return Option.getOrNull(decodeIntegrationConfig(config));
};

// ---------------------------------------------------------------------------
// Tool annotations — upstream MCP ToolAnnotations we honour (destructiveHint
// drives requiresApproval).
// ---------------------------------------------------------------------------

export const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean),
});
export type McpToolAnnotations = typeof McpToolAnnotations.Type;

// ---------------------------------------------------------------------------
// Tool binding — maps a persisted (sanitized) tool name back to its real MCP
// tool name and upstream annotations, persisted per-connection so invokeTool
// can dial the server with the correct name.
// ---------------------------------------------------------------------------

export const McpToolBinding = Schema.Struct({
  /** Sanitized, address-safe tool name (the `<tool>` address segment). */
  toolId: Schema.String,
  /** The real MCP tool name as advertised by the server. */
  toolName: Schema.String,
  description: Schema.NullOr(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(McpToolAnnotations),
});
export type McpToolBinding = typeof McpToolBinding.Type;
