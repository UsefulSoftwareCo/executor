/** HTTP MCP helpers. Requires the optional @modelcontextprotocol/client and @modelcontextprotocol/core peers. */
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

/**
 * A router over a server's tools for the selected account. Its title, description and
 * instructions come from the server. Kinds override uncertain upstream read-only hints.
 */
export const mcpRouter = (options: McpCatalogOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    mcpCatalog(options, kinds),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
