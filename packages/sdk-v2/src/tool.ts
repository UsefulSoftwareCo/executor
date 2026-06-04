import type { ConnectionName, IntegrationSlug, Owner, ToolAddress, ToolName } from "./ids";

/* Tools belong to a connection and are PERSISTED, like v1 — not resolved live on
 * every list. A plugin's `resolveTools` produces them at create/refresh (openapi
 * from the integration's spec; mcp by dialing the connection's server), the SDK
 * stamps each with its address and stores it, and `tools.list` is a read. */

/** A tool as produced by a plugin's `resolveTools` — the definition, no address
 *  yet (the SDK stamps that from the owning connection). */
export type ToolDef = {
  readonly name: ToolName;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
};

/** A persisted, addressable tool as returned by `tools.list`. */
export type Tool = ToolDef & {
  readonly address: ToolAddress;
};

/** Narrow `tools.list` to a subset; omit for the whole catalog. */
export type ToolListFilter = {
  readonly integration?: IntegrationSlug;
  readonly owner?: Owner;
  readonly connection?: ConnectionName;
};
