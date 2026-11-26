import * as Cloudflare from "alchemy/Cloudflare";
import type { McpSession } from "./mcp.ts";

export class McpServer extends Cloudflare.Worker<McpServer, {}, McpSession>()("McpServer") {}
