/**
 * The credentials of the operator's OAuth clients on Cloud (`notes/oauth.md`, "First-party
 * clients"), shared by the CI stack that stores production's and the deploy that reads them. The
 * clients themselves are defined in `@executor-js/hosted-server`; these are the settings named by
 * `firstPartyOAuthCredentialSettings` for its `github`, `google` and `slack` clients. Production (`v2`)
 * requires the GitHub App's, so a deploy without them fails instead of silently dropping it.
 */

/** v1's Executor.sh GitHub App: production's `github` client. */
export const firstPartyGitHubSettings = {
  clientId: "EXECUTOR_OAUTH_GITHUB_CLIENT_ID",
  clientSecret: "EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET",
} as const;

/** Executor for Google: the `google` client, offered once both are set. */
export const firstPartyGoogleSettings = {
  clientId: "EXECUTOR_OAUTH_GOOGLE_CLIENT_ID",
  clientSecret: "EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET",
} as const;

/** Executor for Slack: the `slack` client, which renews and reconnects its accounts once both are set. */
export const firstPartySlackSettings = {
  clientId: "EXECUTOR_OAUTH_SLACK_CLIENT_ID",
  clientSecret: "EXECUTOR_OAUTH_SLACK_CLIENT_SECRET",
} as const;

/** Zoho CRM's Multi-DC client, offered only when both credentials are set. */
export const firstPartyZohoSettings = {
  clientId: "EXECUTOR_OAUTH_ZOHO_CLIENT_ID",
  clientSecret: "EXECUTOR_OAUTH_ZOHO_CLIENT_SECRET",
} as const;

/** The Agents vault item holding the GitHub App's client ID (`username`) and secret (`credential`). */
export const firstPartyGitHubItem = "Executor.sh GitHub App";

const storedBy =
  "and run `bun run ci:deploy`, which stores them in the GitHub production environment that " +
  "`.github/workflows/deploy.yml` passes to the Worker";

/** What to set when production lacks the GitHub App's credentials. */
export const missingFirstPartyGitHubClient =
  `${firstPartyGitHubSettings.clientId} and ${firstPartyGitHubSettings.clientSecret} are required ` +
  "on the production stage (v2), which offers v1's Executor.sh GitHub App as its `github` OAuth " +
  `client: add \`${firstPartyGitHubSettings.clientId}=op://Agents/${firstPartyGitHubItem}/username\` ` +
  `and \`${firstPartyGitHubSettings.clientSecret}=op://Agents/${firstPartyGitHubItem}/credential\` ` +
  `to .env.ci.op ${storedBy}.`;

/** What to set when only one of the Google client's credentials is in `.env.ci.op`. */
export const partialFirstPartyGoogleClient =
  `Set ${firstPartyGoogleSettings.clientId} and ${firstPartyGoogleSettings.clientSecret} in ` +
  ".env.ci.op together, from the Agents vault item `Google OAuth - Production` (`username` and " +
  "`credential`), or set neither.";

/** What to set when only one of the Slack client's credentials is in `.env.ci.op`. */
export const partialFirstPartySlackClient =
  `Set ${firstPartySlackSettings.clientId} and ${firstPartySlackSettings.clientSecret} in ` +
  ".env.ci.op together, from the Executor vault item `Slack OAuth - Production` (`username` and " +
  "`credential`), or set neither.";

/** What to set if only one Zoho Multi-DC credential is configured. */
export const partialFirstPartyZohoClient = `Set ${firstPartyZohoSettings.clientId} and ${firstPartyZohoSettings.clientSecret} together, or leave both unset.`;
