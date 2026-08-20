// An integration's stored `kind` mostly matches the plugin key that owns its
// add/edit surfaces, except where a provider ships under a protocol plugin
// (Google Discovery specs are served by the OpenAPI plugin's Google provider).
// The picker, the grid, and the favicon resolver all need the same answer.
const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
};

export const pluginKeyForIntegrationKind = (kind: string): string =>
  KIND_TO_PLUGIN_KEY[kind] ?? kind;
