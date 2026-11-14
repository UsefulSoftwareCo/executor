/** Public catalog declarations used as independent inputs to the hosted OAuth scenarios. */
export const catalogOAuthFixtures = [
  {
    id: "NOTION",
    name: "Notion",
    host: "api.notion.com",
    server: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      tokenRequestFormat: "json",
      authorizationParams: { owner: "user" },
    },
    scopes: [],
    separator: " ",
    parameter: ["owner", "user"],
  },
  {
    id: "TODOIST",
    name: "Todoist",
    host: "api.todoist.com",
    server: {
      authorizationUrl: "https://app.todoist.com/oauth/authorize",
      tokenUrl: "https://api.todoist.com/oauth/access_token",
      scopeSeparator: ",",
    },
    scopes: ["data:read_write", "data:delete", "project:delete"],
    separator: ",",
    parameter: [],
  },
  {
    id: "TRELLO",
    name: "Trello",
    host: "api.trello.com",
    server: {
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      tokenRequestFormat: "json",
      authorizationParams: { prompt: "consent" },
    },
    scopes: [
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
    ],
    separator: " ",
    parameter: ["prompt", "consent"],
  },
] as const;

export const catalogOAuthCallback = "https://catalog-callback.example.test/api/oauth/callback";
