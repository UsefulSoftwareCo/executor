import { Context } from "effect";
import type { McpMetadataStorage } from "@executor-js/mcp";

/** Supplied by the process or Worker edge; shared MCP logic imports no native storage APIs. */
export class SelfHostMcpStorage extends Context.Service<SelfHostMcpStorage, McpMetadataStorage>()(
  "self-host/McpStorage",
) {}
