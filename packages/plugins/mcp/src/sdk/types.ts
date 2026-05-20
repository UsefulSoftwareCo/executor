import { Effect, Schema } from "effect";
import {
  ConfiguredCredentialValue,
  credentialSlotKey,
  SecretBackedMap,
  SecretBackedValue,
} from "@executor-js/sdk/shared";
import {
  HttpConfiguredValueInput,
  HttpCredentialInput,
  HttpOAuthConfigureInput,
} from "@executor-js/sdk/http-source";

export { SecretBackedMap, SecretBackedValue };

// ---------------------------------------------------------------------------
// Remote transport type
// ---------------------------------------------------------------------------

export const McpRemoteTransport = Schema.Literals(["streamable-http", "sse", "auto"]);
export type McpRemoteTransport = typeof McpRemoteTransport.Type;

/** All transport types (used in the connector layer) */
export const McpTransport = Schema.Literals(["streamable-http", "sse", "stdio", "auto"]);
export type McpTransport = typeof McpTransport.Type;

export const ConfiguredMcpCredentialValue = ConfiguredCredentialValue;
export type ConfiguredMcpCredentialValue = typeof ConfiguredMcpCredentialValue.Type;

export const McpConfiguredValueInput = HttpConfiguredValueInput;
export type McpConfiguredValueInput = typeof McpConfiguredValueInput.Type;

export const McpCredentialInput = HttpCredentialInput;
export type McpCredentialInput = typeof McpCredentialInput.Type;

export const mcpHeaderSlot = (name: string): string => credentialSlotKey("header", name);
export const mcpQueryParamSlot = (name: string): string => credentialSlotKey("query_param", name);
export const MCP_HEADER_AUTH_SLOT = "auth:header";
export const MCP_OAUTH_CONNECTION_SLOT = "auth:oauth2:connection";
export const MCP_OAUTH_CLIENT_ID_SLOT = "auth:oauth2:client-id";
export const MCP_OAUTH_CLIENT_SECRET_SLOT = "auth:oauth2:client-secret";

// ---------------------------------------------------------------------------
// Connection auth (only applies to remote sources)
//
// `oauth2` is a source-owned credential slot. Concrete per-user or
// per-workspace connection ids live in core credential_binding rows.
// ---------------------------------------------------------------------------

/** JSON object loosely typed — used for opaque OAuth state we just round-trip. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export { JsonObject as McpJsonObject };

export const McpConnectionAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("header"),
    headerName: Schema.String,
    secretSlot: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    connectionSlot: Schema.String,
    clientIdSlot: Schema.optional(Schema.String),
    clientSecretSlot: Schema.optional(Schema.String),
  }),
]);
export type McpConnectionAuth = typeof McpConnectionAuth.Type;

export const McpConnectionAuthInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    oauth2: Schema.optional(HttpOAuthConfigureInput),
  }),
]);
export type McpConnectionAuthInput = typeof McpConnectionAuthInput.Type;

// ---------------------------------------------------------------------------
// Stored source data — discriminated union on transport
// ---------------------------------------------------------------------------

/** Common fields for remote string map schemas */
const StringMap = Schema.Record(Schema.String, Schema.String);

export const McpRemoteSourceData = Schema.Struct({
  transport: Schema.Literal("remote"),
  /** The MCP server endpoint URL */
  endpoint: Schema.String,
  /** Transport preference for this remote source */
  remoteTransport: McpRemoteTransport.pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed("auto" as const)),
  ),
  /** Extra query params appended to the endpoint URL */
  queryParams: Schema.optional(Schema.Record(Schema.String, ConfiguredMcpCredentialValue)),
  /** Extra headers sent on every request */
  headers: Schema.optional(Schema.Record(Schema.String, ConfiguredMcpCredentialValue)),
  /** Auth configuration */
  auth: McpConnectionAuth,
});
export type McpRemoteSourceData = typeof McpRemoteSourceData.Type;

export const McpStdioSourceData = Schema.Struct({
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
export type McpStdioSourceData = typeof McpStdioSourceData.Type;

export const McpStoredSourceData = Schema.Union([McpRemoteSourceData, McpStdioSourceData]);
export type McpStoredSourceData = typeof McpStoredSourceData.Type;

// ---------------------------------------------------------------------------
// Tool binding — maps a registered ToolId back to the MCP tool name
// ---------------------------------------------------------------------------

export const McpToolAnnotations = Schema.Struct({
  title: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  idempotentHint: Schema.optional(Schema.Boolean),
  openWorldHint: Schema.optional(Schema.Boolean),
});
export type McpToolAnnotations = typeof McpToolAnnotations.Type;

export const McpToolBinding = Schema.Struct({
  toolId: Schema.String,
  toolName: Schema.String,
  description: Schema.NullOr(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(McpToolAnnotations),
});
export type McpToolBinding = typeof McpToolBinding.Type;
