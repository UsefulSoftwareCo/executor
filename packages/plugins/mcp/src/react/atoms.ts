import type { IntegrationSlug } from "@executor-js/sdk/shared";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { McpClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms (v2)
//
// An MCP server is an integration. `getServer` reads the integration row's
// opaque config (transport, endpoint, auth template). Credentials are separate
// owner-scoped connections, created through the core connections / oauth surface
// — there is no per-server credential binding to read here anymore.
// ---------------------------------------------------------------------------

export const mcpServerAtom = (slug: IntegrationSlug) =>
  McpClient.query("mcp", "getServer", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

/** Locally installed Codex plugins with stdio MCP servers (one-click stdio
 *  presets). Availability is a filesystem fact that can change while the add
 *  form is open (e.g. the user installs Codex mid-flow), hence the short TTL. */
export const codexPluginsAtom = McpClient.query("mcp", "listCodexPlugins", {
  timeToLive: "15 seconds",
});

export const probeMcpEndpoint = McpClient.mutation("mcp", "probeEndpoint");
export const addMcpServer = McpClient.mutation("mcp", "addServer");
export const removeMcpServer = McpClient.mutation("mcp", "removeServer");
export const configureMcpServer = McpClient.mutation("mcp", "configureServer");
// Merge-append auth methods onto an integration's `authenticationTemplate`.
export const configureMcpAuth = McpClient.mutation("mcp", "configureAuth");
