/**
 * The operator's own OAuth clients (`notes/oauth.md`, "First-party clients"). What each client is,
 * its authorization server, scope menu and placement, is reviewed here in code. Only its
 * credentials are settings, `EXECUTOR_OAUTH_<ID>_CLIENT_ID` and `EXECUTOR_OAUTH_<ID>_CLIENT_SECRET`
 * (the ID in upper case, `-` as `_`), and a client is offered only when both are set. Reviewed
 * client labels use `EXECUTOR_PRODUCT_NAME`, which defaults to `Executor`.
 */
import { FirstPartyOAuthClient } from "@executor-js/sdk/core";
import { Config, Effect, Option, Redacted, Schema, Struct } from "effect";
import { FirstPartyOAuthClientsInvalid } from "../contracts/oauth-client-metadata.ts";

/** A first-party client without its credentials: everything about it that code reviews. */
export const FirstPartyOAuthClientDefinition = FirstPartyOAuthClient.mapFields(
  Struct.omit(["clientId", "clientSecret"]),
);
export type FirstPartyOAuthClientDefinition = typeof FirstPartyOAuthClientDefinition.Encoded;

/**
 * Every scope Executor for Google may ask for and a grant may hold. This is v1's
 * `GOOGLE_ALLOWED_SCOPES` (`apps/cloud/src/engine/first-party-oauth-clients.ts` in
 * UsefulSoftwareCo/executor): the scopes v1's catalog requested for its 13 first-party Google
 * presets (Calendar, Meet, Gmail, Sheets, Drive, Docs, Slides, Forms, Tasks, People, Photos
 * Library, Photos Picker and Search Console), each with `openid email profile`, and
 * `gmail.modify`, which Gmail connections made before the full-Gmail review keep. It is the scope
 * set submitted for the production app's review. Google reports `email` and `profile` as granted
 * under their `userinfo` names, and a grant holds only allowed scopes, so those two are allowed
 * as well.
 */
const googleAllowedScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/user.addresses.read",
  "https://www.googleapis.com/auth/user.birthday.read",
  "https://www.googleapis.com/auth/user.emails.read",
  "https://www.googleapis.com/auth/user.gender.read",
  "https://www.googleapis.com/auth/user.organization.read",
  "https://www.googleapis.com/auth/user.phonenumbers.read",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/webmasters",
];

/**
 * The user scopes Executor for Slack may ask for and a grant may hold: v1's `slackMcpUserScopes`
 * (`packages/react/src/lib/slack-mcp-oauth.ts` in UsefulSoftwareCo/executor), the user scopes
 * approved on v1's Slack MCP app, and the ones Slack granted v1's connections of that app beyond
 * them (`im:read`, `lists:read`, `lists:write`, `files:write`), which the app is therefore
 * configured for. Slack's MCP resource advertises more, which a sign-in with this client leaves
 * out, as v1 did.
 */
const slackMcpUserScopes = [
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
  "im:read",
  "lists:read",
  "lists:write",
  "files:write",
];

/** OAuth App scopes declared by the official GitHub REST app. */
const githubRestScopes = [
  "repo",
  "read:org",
  "workflow",
  "gist",
  "notifications",
  "read:user",
  "user:email",
];

/**
 * The clients an operator can turn on by setting their credentials.
 *
 * - `github` is v1's Executor.sh GitHub App. A GitHub App has no scopes, so it is offered only to
 *   providers that declare none; its registered permissions decide what a token can do. GitHub
 *   reports granted scopes comma-separated. Its tokens go only to GitHub's hosts: `api.github.com`;
 *   `uploads.github.com`, where GitHub takes release asset uploads; and `api.githubcopilot.com`,
 *   GitHub's MCP server. GitHub accepts GitHub App user tokens on all three, and v1 sent this
 *   client's tokens to every GitHub REST operation, uploads included, and to GitHub's MCP server.
 * - `github-oauth` is an optional OAuth App for the official GitHub REST app. It requests that
 *   app's declared scopes and sends its managed token only to `api.github.com`. It is separate
 *   from the GitHub App client above, whose permission model remains unchanged.
 * - `google` is Executor for Google, v1's Google client. `access_type=offline` and
 *   `prompt=consent` make every sign-in return a refresh token. It has no revocation URL: Google
 *   revokes every grant a user gave the client at once, so removing one account would end the
 *   user's other Google accounts in every organization. Its tokens go to Google's API hosts.
 * - `slack` is Executor for Slack, v1's Slack MCP client (`apps/cloud/src/engine/first-party-oauth-
 *   clients.ts` in UsefulSoftwareCo/executor). It signs in at Slack's user-token endpoints, which
 *   Slack's MCP server (`mcp.slack.com`) names, with the resource `https://mcp.slack.com`, as v1
 *   did. Slack may answer with the user's grant under `authed_user`, its scopes comma-separated.
 *   It is unlisted, as in v1: Slack lets an app use MCP outside its own workspace only once it is
 *   published in the Slack Marketplace, so it signs in no new accounts, but reconnects and renews
 *   those it already holds. Its tokens go only to Slack's MCP server.
 */
export const firstPartyOAuthClientDefinitions: readonly FirstPartyOAuthClientDefinition[] = [
  {
    id: "github",
    label: "Executor for GitHub",
    server: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      grantedScopeSeparator: ",",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: [],
    placement: {
      hosts: [
        "api.github.com",
        // GitHub's release asset upload host; v1 sent the token there too.
        "uploads.github.com",
        // GitHub's MCP server accepts GitHub App user tokens; v1 sent this client's tokens there.
        "api.githubcopilot.com",
      ],
    },
  },
  {
    id: "github-oauth",
    label: "Executor for GitHub",
    server: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      grantedScopeSeparator: ",",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: githubRestScopes,
    allowedScopes: githubRestScopes,
    placement: { hosts: ["api.github.com"] },
  },
  {
    id: "google",
    label: "Executor for Google",
    server: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      authorizationParams: { access_type: "offline", prompt: "consent" },
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: ["openid", "email", "profile"],
    allowedScopes: googleAllowedScopes,
    placement: { hosts: ["*.googleapis.com"] },
  },
  {
    id: "slack",
    label: "Executor for Slack",
    server: {
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
      grantedScopeSeparator: ",",
      tokenResponse: { path: "authed_user" },
      resource: "https://mcp.slack.com",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: slackMcpUserScopes,
    allowedScopes: slackMcpUserScopes,
    placement: { hosts: ["mcp.slack.com"] },
    unlisted: true,
  },
];

/** The two settings that hold the credentials of the client `id`. */
export const firstPartyOAuthCredentialSettings = (id: string) => {
  const prefix = `EXECUTOR_OAUTH_${id.toUpperCase().replaceAll("-", "_")}`;
  return { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` };
};

/**
 * Client definitions an E2E host adds to the reviewed ones, as a JSON array of
 * `FirstPartyOAuthClientDefinition`, so scenarios can sign in at a loopback authorization server.
 * They carry no credentials: those are the same settings as every client's. Any other host refuses
 * to start with it set.
 */
export const testDefinitionsSetting = "EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS";

/** The settings were rejected for `problems`, which name settings and clients, never a value. */
const invalid = (problems: ReadonlyArray<string>) =>
  new FirstPartyOAuthClientsInvalid({
    message: `The operator's OAuth client settings are invalid. ${problems.join(" ")}`,
    problems,
  });

/** GitHub Actions passes an unset secret as an empty string, so empty means unset. */
const setting = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Effect.map(Option.filter((value) => Redacted.value(value) !== "")),
  );

const Definitions = Schema.Array(FirstPartyOAuthClientDefinition);

const testDefinitions = (allowed: boolean) =>
  Effect.gen(function* () {
    const value = yield* setting(testDefinitionsSetting);
    if (Option.isNone(value)) return [];
    if (!allowed)
      return yield* invalid([
        `${testDefinitionsSetting} is set, but only E2E test hosts read it. Unset it.`,
      ]);
    // Definitions hold no credentials, so the parser's message can be repeated.
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Definitions))(
      Redacted.value(value.value),
    ).pipe(
      Effect.mapError((error) =>
        invalid([`${testDefinitionsSetting} is invalid: ${error.message}`]),
      ),
    );
  });

/**
 * The operator's clients whose credentials are set, checked at startup. A client ID without its
 * secret, or a secret without its ID, stops the host and names the missing setting; no value is
 * ever repeated. `testDefinitions` lets an E2E host add `EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS`;
 * every other host passes `false` and refuses to start with it set.
 */
export const firstPartyOAuthClients = (options: { readonly testDefinitions: boolean }) =>
  Effect.gen(function* () {
    const productName = yield* Config.NonEmptyString("EXECUTOR_PRODUCT_NAME").pipe(
      Config.withDefault("Executor"),
    );
    const reviewed = yield* Schema.decodeUnknownEffect(Definitions)(
      firstPartyOAuthClientDefinitions,
    ).pipe(Effect.orDie);
    const definitions = [...reviewed, ...(yield* testDefinitions(options.testDefinitions))];
    const seen = new Set<string>();
    const problems: string[] = [];
    const clients: FirstPartyOAuthClient[] = [];
    for (const definition of definitions) {
      if (seen.has(definition.id)) {
        problems.push(`Two clients have the ID ${definition.id}.`);
        continue;
      }
      seen.add(definition.id);
      const names = firstPartyOAuthCredentialSettings(definition.id);
      const clientId = yield* setting(names.clientId);
      const clientSecret = yield* setting(names.clientSecret);
      const secretless = definition.tokenEndpointAuthMethod === "none";
      if (Option.isNone(clientId)) {
        if (Option.isSome(clientSecret))
          problems.push(`${names.clientSecret} is set without ${names.clientId}.`);
        continue;
      }
      if (secretless && Option.isSome(clientSecret)) {
        problems.push(
          `${names.clientSecret} is set, but the ${definition.id} client authenticates without a secret.`,
        );
        continue;
      }
      if (!secretless && Option.isNone(clientSecret)) {
        problems.push(`${names.clientId} is set without ${names.clientSecret}.`);
        continue;
      }
      // The client's own checks, such as every default scope being allowed. A failure names the
      // client only: the parser's message could quote a credential.
      const client = yield* Schema.decodeUnknownEffect(Schema.toType(FirstPartyOAuthClient))({
        ...definition,
        clientId: Redacted.value(clientId.value),
        ...(Option.isSome(clientSecret) ? { clientSecret: clientSecret.value } : {}),
      }).pipe(Effect.option);
      if (Option.isNone(client)) {
        problems.push(`The ${definition.id} client's definition or client ID is invalid.`);
        continue;
      }
      const service =
        definition.id === "google"
          ? "Google"
          : definition.id === "github" || definition.id === "github-oauth"
            ? "GitHub"
            : definition.id === "slack"
              ? "Slack"
              : undefined;
      clients.push(
        service === undefined
          ? client.value
          : { ...client.value, label: `${productName} for ${service}` },
      );
    }
    if (problems.length > 0) return yield* invalid(problems);
    return clients;
  });
