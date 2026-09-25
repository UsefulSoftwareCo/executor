/** HTTP MCP helpers. Requires the optional @modelcontextprotocol/sdk peer. */
import type { OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import { mcpCatalog, type McpCatalogOptions } from "./implementation/mcp-catalog.ts";
export type { McpCatalogOptions } from "./implementation/mcp-catalog.ts";
export {
  McpError,
  type McpToolContext,
  type McpToolsOptions,
  type McpToolResult,
} from "./contracts/mcp.ts";

/** Discover operations for the selected account. Kinds override uncertain upstream read-only hints. */
export const mcpOperations = (options: McpCatalogOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    mcpCatalog(options, kinds),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
