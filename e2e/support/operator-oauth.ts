import { Schema } from "effect";

/**
 * The operator's OAuth clients every managed local Cloud is configured with. The first client's
 * authorization server is a loopback issuer on `port`, which only the scenario that proves Cloud's
 * operator settings starts; no other provider shares its endpoints, so it is offered to no one
 * else. The clients v1's first-party connections move to share a loopback service on `v1Port`,
 * which only the v1 import's first-party scenario starts; see `v1FirstPartyClients`.
 */
export const OperatorOAuthFixture = Schema.Struct({
  port: Schema.Number,
  clientId: Schema.String,
  clientSecret: Schema.String,
  v1Port: Schema.Number,
});
/** Where a managed Cloud run records its operator OAuth fixture, under the run directory. */
export const operatorOAuthFile = "operator-oauth.json";

/** The synthetic credentials of each client in `v1FirstPartyClients`, by ID. */
export const v1FirstPartyCredentials = {
  "v1-google": { clientId: "synthetic-v1-google-client", secret: "synthetic-v1-google-secret" },
  "v1-github": { clientId: "synthetic-v1-github-client", secret: "synthetic-v1-github-secret" },
  "v1-slack": { clientId: "synthetic-v1-slack-client", secret: "synthetic-v1-slack-secret" },
  "v1-github-both": {
    clientId: "synthetic-v1-github-both-client",
    secret: "synthetic-v1-github-both-secret",
  },
  "v1-github-api": {
    clientId: "synthetic-v1-github-api-client",
    secret: "synthetic-v1-github-api-secret",
  },
} as const;

/**
 * Two host names of one synthetic GitHub-shaped service, like `api.github.com` and
 * `uploads.github.com`, on the loopback port of `origin`. `*.localhost` resolves to loopback.
 */
export const v1GitHubHosts = (origin: string) => {
  const { port } = new URL(origin);
  return {
    api: `api.synthetic-github.localhost:${port}`,
    uploads: `uploads.synthetic-github.localhost:${port}`,
  };
};

/** The scopes the Google-shaped client allows. */
export const v1GoogleScopes = ["openid", "email", "profile", "synthetic.read", "synthetic.write"];
/** The user scopes the Slack-shaped client asks for and allows. */
export const v1SlackScopes = ["chat:write", "search:read.public"];

/**
 * Test clients shaped as the reviewed `google`, `github` and `slack` clients, which v1's
 * first-party connections `first-party:v1-google`, `first-party:v1-github` and
 * `first-party:v1-slack` move to. Their authorization servers are paths of one loopback service
 * at `origin`, and their tokens go only to its host:
 *
 * - `v1-google` has a scope menu and asks for offline access;
 * - `v1-github` allows no scopes and reports granted scopes comma-separated;
 * - `v1-slack` is unlisted, sends its own RFC 8707 resource and finds the grant under
 *   `authed_user`, as Slack's user-token endpoints answer.
 *
 * Two more GitHub-shaped clients send their tokens to the hosts of `v1GitHubHosts` instead:
 * `v1-github-both` to its API and upload hosts, as the reviewed `github` client does, and
 * `v1-github-api` to its API host only.
 */
export const v1FirstPartyClients = (origin: string) => {
  const host = new URL(origin).host;
  const github = v1GitHubHosts(origin);
  const githubShaped = (id: string, path: string, hosts: readonly string[]) => ({
    id,
    label: `Executor for Synthetic GitHub (${path})`,
    server: {
      authorizationUrl: `${origin}/${path}/authorize`,
      tokenUrl: `${origin}/${path}/token`,
      grantedScopeSeparator: ",",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: [],
    placement: { hosts },
  });
  return [
    {
      id: "v1-google",
      label: "Executor for Synthetic Google",
      server: {
        authorizationUrl: `${origin}/google/authorize`,
        tokenUrl: `${origin}/google/token`,
        authorizationParams: { access_type: "offline", prompt: "consent" },
      },
      tokenEndpointAuthMethod: "client_secret_post",
      defaultScopes: ["openid", "email", "profile"],
      allowedScopes: v1GoogleScopes,
      placement: { hosts: [host] },
    },
    {
      id: "v1-github",
      label: "Executor for Synthetic GitHub",
      server: {
        authorizationUrl: `${origin}/github/authorize`,
        tokenUrl: `${origin}/github/token`,
        grantedScopeSeparator: ",",
      },
      tokenEndpointAuthMethod: "client_secret_post",
      defaultScopes: [],
      placement: { hosts: [host] },
    },
    {
      id: "v1-slack",
      label: "Executor for Synthetic Slack",
      server: {
        authorizationUrl: `${origin}/slack/authorize`,
        tokenUrl: `${origin}/slack/token`,
        grantedScopeSeparator: ",",
        tokenResponse: { path: "authed_user" },
        resource: `${origin}/slack`,
      },
      tokenEndpointAuthMethod: "client_secret_post",
      defaultScopes: v1SlackScopes,
      allowedScopes: v1SlackScopes,
      placement: { hosts: [host] },
      unlisted: true,
    },
    githubShaped("v1-github-both", "github-both", [github.api, github.uploads]),
    githubShaped("v1-github-api", "github-api", [github.api]),
  ];
};
