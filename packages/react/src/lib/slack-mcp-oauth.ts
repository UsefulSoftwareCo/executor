/** User scopes approved on Executor's Slack MCP OAuth app and embedded in the
 *  BYO-app creation manifest. Cloud uses the same list as its first-party
 *  discovery cap so Slack metadata cannot expand the requested grant beyond
 *  the provider-side registration. */
export const slackMcpUserScopes = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "reactions:write",
  "reactions:read",
  "emoji:read",
  "files:read",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "channels:read",
  "groups:read",
  "mpim:read",
] as const;
