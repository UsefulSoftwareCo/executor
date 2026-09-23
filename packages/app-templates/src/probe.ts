/** Read-only import-time probe. The transport implementation is the same framework helper used by deployed apps. */
import { Effect } from "effect";
import { mcpToolsEffect } from "apps/mcp/effect";
import type { McpToolsOptions } from "apps/mcp";
export { McpError } from "apps/mcp";

/** Confirm a public server can expose tools; no upstream tool is invoked. */
export const probeMcp = (options: McpToolsOptions) => mcpToolsEffect(options).pipe(Effect.asVoid);
