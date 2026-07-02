import type { ConnectionName, IntegrationSlug, Owner, ToolAddress, ToolName } from "./ids";

/* Tools belong to a connection and are PERSISTED, like v1 — not resolved live on
 * every list. A plugin produces them at create/refresh (openapi from the
 * integration's spec; mcp by dialing the connection's server), the SDK stamps
 * each with its address and stores it per-connection (option C), and `tools.list`
 * is a read. */

/** Default-policy hints a plugin attaches to a tool — enforced by the executor
 *  before the handler runs. */
export interface ToolAnnotations {
  readonly requiresApproval?: boolean;
  readonly approvalDescription?: string;
  readonly mayElicit?: boolean;
}

/** A tool as produced by a plugin — the definition, no address yet (the SDK
 *  stamps that from the owning connection). */
export interface ToolDef {
  readonly name: ToolName;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}

/** A persisted, addressable tool as returned by `tools.list`. */
export interface Tool {
  readonly address: ToolAddress;
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly connection: ConnectionName;
  readonly name: ToolName;
  /** The plugin that owns the connection's integration. */
  readonly pluginId: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
  /** True for plugin-contributed static tools (for example Executor's own
   *  configuration tools). Static tools have no backing connection even though
   *  they carry owner/connection metadata for UI grouping. */
  readonly static?: boolean;
}

/** Narrow `tools.list` to a subset; omit for the whole catalog. */
export interface ToolListFilter {
  readonly integration?: IntegrationSlug;
  readonly owner?: Owner;
  readonly connection?: ConnectionName;
  /** Case-insensitive substring match against `name` OR `description`. */
  readonly query?: string;
  /** Resolve plugin-derived annotations. Defaults to true. */
  readonly includeAnnotations?: boolean;
  /** Include tools whose effective `tool_policy` is `block`. Defaults to `false`
   *  so agent-facing surfaces silently omit blocked tools. */
  readonly includeBlocked?: boolean;
}
