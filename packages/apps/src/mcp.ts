/** HTTP MCP helpers. Requires the optional @modelcontextprotocol/sdk peer. */
import { protocolOperations, type OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import type { McpToolsOptions } from "./contracts/mcp.ts";
import { mcpToolsEffect } from "./implementation/mcp.ts";
export {
  McpError,
  type McpToolContext,
  type McpToolsOptions,
  type McpToolResult,
} from "./contracts/mcp.ts";

/** Discover operations for the selected account. Kinds override uncertain upstream read-only hints. */
export const mcpOperations = (options: McpToolsOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    mcpToolsEffect(options).pipe(Effect.map((operations) => protocolOperations(operations, kinds))),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
