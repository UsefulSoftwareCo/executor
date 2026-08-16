/**
 * Temporary MCP Apps server helpers for the v2 MCP SDK.
 *
 * This is a wire-compatible local copy of the helpers currently published by
 * `@modelcontextprotocol/ext-apps/server`. The upstream package still targets
 * the v1 SDK; remove this module once
 * https://github.com/modelcontextprotocol/ext-apps/issues/702 is resolved.
 */
import type {
  ClientCapabilities,
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  RegisteredTool,
  ResourceMetadata,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";

/** The legacy flat metadata key understood by older MCP Apps hosts. */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";

/** MIME type used by MCP Apps HTML resources. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** MCP capability-extension identifier for MCP Apps support. */
export const EXTENSION_ID = "io.modelcontextprotocol/ui";

/** Model/app visibility scopes supported by MCP Apps tool metadata. */
export type McpAppToolVisibility = "model" | "app";

/** MCP Apps metadata attached to a tool. */
export type McpAppToolMeta = {
  readonly resourceUri?: string;
  readonly visibility?: readonly McpAppToolVisibility[];
};

/** MCP Apps capability data advertised by a client. */
export type McpUiClientCapabilities = {
  readonly mimeTypes?: readonly string[];
};

/** Client capabilities shape carrying the MCP Apps extension. */
export type McpAppsClientCapabilities = ClientCapabilities & {
  readonly extensions?: Record<string, McpUiClientCapabilities>;
};

/** Tool configuration accepted by {@link registerAppTool}. */
export type McpAppToolConfig<
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  OutputArgs extends StandardSchemaWithJSON | undefined = undefined,
> = {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: InputArgs;
  readonly outputSchema?: OutputArgs;
  readonly annotations?: ToolAnnotations;
  readonly _meta: Record<string, unknown> & {
    readonly ui?: McpAppToolMeta;
    readonly [RESOURCE_URI_META_KEY]?: string;
  };
};

/** Resource configuration accepted by {@link registerAppResource}. */
export type McpAppResourceConfig = ResourceMetadata & {
  readonly _meta?: Record<string, unknown> & {
    readonly ui?: Record<string, unknown>;
  };
};

/**
 * Register an MCP Apps tool while mirroring nested and legacy resource URI
 * metadata in both directions.
 */
export const registerAppTool = <
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  OutputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  server: Pick<McpServer, "registerTool">,
  name: string,
  config: McpAppToolConfig<InputArgs, OutputArgs>,
  callback: ToolCallback<InputArgs>,
): RegisteredTool => {
  const ui = config._meta.ui;
  const legacyResourceUri = config._meta[RESOURCE_URI_META_KEY];
  let metadata = config._meta;

  if (ui?.resourceUri && !legacyResourceUri) {
    metadata = { ...config._meta, [RESOURCE_URI_META_KEY]: ui.resourceUri };
  } else if (legacyResourceUri && !ui?.resourceUri) {
    metadata = { ...config._meta, ui: { ...ui, resourceUri: legacyResourceUri } };
  }

  return server.registerTool(
    name,
    {
      ...config,
      _meta: metadata,
    },
    callback,
  );
};

/** Register an MCP Apps resource, defaulting its MIME type when omitted. */
export const registerAppResource = (
  server: Pick<McpServer, "registerResource">,
  name: string,
  uri: string,
  config: McpAppResourceConfig,
  readCallback: ReadResourceCallback,
): RegisteredResource =>
  server.registerResource(name, uri, { mimeType: RESOURCE_MIME_TYPE, ...config }, readCallback);

/** Read MCP Apps extension data from a client's capabilities. */
export const getUiCapability = (
  clientCapabilities: McpAppsClientCapabilities | null | undefined,
): McpUiClientCapabilities | undefined => clientCapabilities?.extensions?.[EXTENSION_ID];
