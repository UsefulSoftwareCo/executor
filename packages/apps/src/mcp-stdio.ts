/** Local MCP process helper. Requires a Node-compatible host and the optional MCP SDK peer. */
import { Effect } from "effect";
import type { ProcessConfig } from "./contracts/mcp.ts";
import { stdioToolsEffect } from "./implementation/mcp-stdio.ts";
import { protocolOperations, type OperationKinds } from "./implementation/protocol-operations.ts";
export { McpError, type McpToolContext, type ProcessConfig } from "./contracts/mcp.ts";

/** Discover an account's tools; each discovery and call owns and closes its subprocess. */
export const stdioOperations = (
  config: ProcessConfig,
  signal?: AbortSignal,
  kinds: OperationKinds = {},
) =>
  Effect.runPromise(
    stdioToolsEffect(config).pipe(Effect.map((tools) => protocolOperations(tools, kinds))),
    signal === undefined ? {} : { signal },
  );
