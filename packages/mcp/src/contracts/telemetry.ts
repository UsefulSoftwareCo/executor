/** What the host says about a request for the MCP operation spans to record. */
import { Context } from "effect";

/**
 * Opaque IDs naming whom the current MCP request runs for, such as a hosted organization's ID and
 * the caller's user ID. A host provides them around its request handler, and each MCP operation
 * span records them from its start, so a failed operation still names them. A program keeps the
 * ones of the request that started it. Only bounded opaque IDs belong here: never a name, an
 * email, a slug or anything the caller sent. Hosts with nothing to name provide none.
 */
export const McpRequestAttributes = Context.Reference<Readonly<Record<string, string>>>(
  "@executor-js/mcp/McpRequestAttributes",
  { defaultValue: () => ({}) },
);
