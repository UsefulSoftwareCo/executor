import type { CatalogRecovery } from "./catalog.ts";

export const customSetupRecovery: CatalogRecovery = {
  action:
    "Write this app with the app-authoring skill, using the MCP server URL you supplied. The refusal's reason says what the server answered.",
  instructions: [
    "Executor adds an MCP server by URL directly only when the server confirms it needs OAuth sign-in or no sign-in.",
    "",
    "Start with the Executor app's executor skill, then follow its app-authoring skill: its integrations guide shows an `mcpRouter` app that sends the API key or other credentials the server documents. Read the server's documentation, ask me how I sign in, then write and deploy the app and help me connect my account.",
  ].join("\n"),
};

export const unknownEntryRecovery: CatalogRecovery = {
  action:
    "Install takes the id of an entry the catalog lists. Add a remote MCP server by its URL with the custom MCP import instead.",
  instructions: [
    "Find the entry in the catalog listing first: search it by text (`search`) and pass the listed `id` as `entry`.",
    "",
    "To add a remote MCP server that is not listed, call the custom MCP import (the API's `apps.importCustom`) with `{ source: { kind: \"mcp\", name, url } }`. For any other service, write an app with the Executor app's app-authoring skill.",
  ].join("\n"),
};
