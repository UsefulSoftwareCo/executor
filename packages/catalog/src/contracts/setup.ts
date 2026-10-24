/**
 * Setup steps for refusals an agent can recover from. The caller may be the agent itself, so each
 * refusal says what to call next. Steps never repeat what the caller sent.
 */
import type { CatalogRecovery } from "./catalog.ts";

/**
 * Recovery for an MCP server added by URL that Executor could not confirm. The caller chose the
 * URL, so the steps never repeat it.
 */
export const customSetupRecovery: CatalogRecovery = {
  action:
    "Write this app with the app-authoring skill, using the MCP server URL you supplied. The refusal's reason says what the server answered.",
  instructions: [
    "An MCP server is added by URL directly only when the server confirms it needs OAuth sign-in or no sign-in.",
    "",
    "Start with the built-in app's executor skill, then follow its app-authoring skill: its integrations guide shows an `mcpRouter` app that sends the API key or other credentials the server documents. Read the server's documentation, ask me how I sign in, then write and deploy the app and help me connect my account.",
  ].join("\n"),
};

/** Recovery for an install whose entry the catalog does not list. */
export const unknownEntryRecovery: CatalogRecovery = {
  action:
    "Install takes the id of an entry the catalog lists. Add a remote MCP server by its URL with the custom MCP import instead.",
  instructions: [
    "Find the entry in the catalog listing first: search it by text (`search`) and pass the listed `id` as `entry`.",
    "",
    "To add a remote MCP server that is not listed, call the custom MCP import (the API's `apps.importCustom`) with `{ source: { kind: \"mcp\", name, url } }`. For any other service, write an app with the Executor app's app-authoring skill.",
  ].join("\n"),
};
