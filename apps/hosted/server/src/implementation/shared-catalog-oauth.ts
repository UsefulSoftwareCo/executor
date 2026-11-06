import type { FirstPartyOAuthClientDefinition } from "./first-party-oauth.ts";

const todoistScopes = ["data:read_write", "data:delete", "project:delete"];
const trelloScopes = [
  "read:board:trello",
  "write:board:trello",
  "write:board:membership:trello",
  "read:organization:trello",
  "write:organization:trello",
  "write:organization:membership:trello",
  "read:member:trello",
  "write:member:trello",
  "read:enterprise:trello",
  "write:enterprise:trello",
  "offline_access",
];

/** Reviewed catalog clients; credentials stay in the host's optional settings. */
export const catalogOAuthClientDefinitions: readonly FirstPartyOAuthClientDefinition[] = [
  {
    id: "notion",
    label: "Executor for Notion",
    server: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      tokenRequestFormat: "json",
      authorizationParams: { owner: "user" },
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    defaultScopes: [],
    allowedScopes: [],
    placement: { hosts: ["api.notion.com"] },
  },
  {
    id: "todoist",
    label: "Executor for Todoist",
    server: {
      authorizationUrl: "https://app.todoist.com/oauth/authorize",
      tokenUrl: "https://api.todoist.com/oauth/access_token",
      scopeSeparator: ",",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: todoistScopes,
    allowedScopes: todoistScopes,
    placement: { hosts: ["api.todoist.com"] },
  },
  {
    id: "trello",
    label: "Executor for Trello",
    server: {
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      tokenRequestFormat: "json",
      authorizationParams: { prompt: "consent" },
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: trelloScopes,
    allowedScopes: trelloScopes,
    placement: { hosts: ["api.trello.com"] },
  },
];
