/** Bind the MCP server Worker without importing its implementation. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { McpSession } from "./mcp.ts";

/**
 * Hosts every MCP session object, so waking one loads the executor and MCP protocol servers,
 * never the API Worker with its routes, dashboard and sign-in stack.
 */
export class McpServer extends Cloudflare.Worker<McpServer, {}, McpSession>()("McpServer") {}
