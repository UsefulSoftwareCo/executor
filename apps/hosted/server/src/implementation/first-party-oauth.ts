import { FirstPartyOAuthClient } from "@executor-js/sdk/core";
import { Config, Effect, Option, Redacted, Schema, Struct } from "effect";
import { FirstPartyOAuthClientsInvalid } from "../contracts/oauth-client-metadata.ts";
import { catalogOAuthClientDefinitions } from "./shared-catalog-oauth.ts";

export const FirstPartyOAuthClientDefinition = FirstPartyOAuthClient.mapFields(
  Struct.omit(["clientId", "clientSecret"]),
);
export type FirstPartyOAuthClientDefinition = typeof FirstPartyOAuthClientDefinition.Encoded;

/**
 * Every scope Executor for Google may ask for. Google lets the production client ask a user for a
 * sensitive or restricted scope only once its OAuth verification approves that scope for the
 * client, and shows "This app is blocked" otherwise, so this list must hold only the scopes
 * approved for it and non-sensitive ones, which need no approval. Add a scope only after Google approves
 * it for the production client; until then an app asking for it is refused before Google's consent
 * screen, and its user signs in with their own client.
 *
 * Sources, kept by the operator: Google's verification approvals for the production client of
 * 2026-10-05 (the Workspace scopes, `https://mail.google.com/` and `gmail.settings.basic` among
 * them) and 2026-10-25 (YouTube, Google Ads, BigQuery and Apps Script). The list began as v1's
 * `GOOGLE_ALLOWED_SCOPES` (`apps/cloud/src/engine/first-party-oauth-clients.ts` in
 * UsefulSoftwareCo/executor): the scopes of v1's 13 first-party Google presets (Calendar, Meet,
 * Gmail, Sheets, Drive, Docs, Slides, Forms, Tasks, People, Photos Library, Photos Picker and
 * Search Console). `openid`, `email` and `profile`, their `userinfo` names, under which Google
 * reports `email` and `profile` granted, and Apps Script metrics are non-sensitive.
 */
const googleSignInScopes = [
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
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
  "https://www.googleapis.com/auth/script.processes",
  "https://www.googleapis.com/auth/script.metrics",
];

/**
 * Scopes Executor for Google grants hold that Google has not approved for the production client,
 * so no sign-in on Cloud asks for them. The grants keep renewing; a sign-in or reconnect asking for
 * one is refused, leading with the user's own client and naming the approved scope that covers it,
 * which grants more. A self-host operator's own Google client asks for them as before
 * (`FirstPartyRegistrations`). Move a scope from here to `googleSignInScopes` once Google approves
 * it; either list is one line per scope.
 *
 * - `gmail.modify`: v1 asked for it, and Gmail connections made then hold it. Google has not
 *   approved it for the production client; the full Gmail scope, `https://mail.google.com/`, is
 *   approved and covers it.
 */
const googleHeldScopes = [
  {
    scope: "https://www.googleapis.com/auth/gmail.modify",
    instead: ["https://mail.google.com/"],
  },
];

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

/**
 * The clients an operator can turn on by setting their credentials.
 *
 * - `github` is v1's Executor.sh GitHub App. A GitHub App has no scopes, so it is offered only to
 *   providers that declare none; its registered permissions decide what a token can do. GitHub
 *   reports granted scopes comma-separated. Its tokens go only to GitHub's hosts: `api.github.com`;
 *   `uploads.github.com`, where GitHub takes release asset uploads; and `api.githubcopilot.com`,
 *   GitHub's MCP server. GitHub accepts GitHub App user tokens on all three, and v1 sent this
 *   client's tokens to every GitHub REST operation, uploads included, and to GitHub's MCP server.
 * - `google` is Executor for Google, v1's Google client. It asks only for the scopes Google approved
 *   for it, and its grants may also hold the held scopes, which it no longer asks for. Like every Google
 *   sign-in, it sends `access_type=offline` and `prompt=consent`, so each returns a refresh token. It has no revocation URL: Google
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
  ...catalogOAuthClientDefinitions,
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
      hosts: ["api.github.com", "uploads.github.com", "api.githubcopilot.com"],
    },
  },
  {
    id: "google",
    label: "Executor for Google",
    server: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: ["openid", "email", "profile"],
    allowedScopes: googleSignInScopes,
    heldScopes: googleHeldScopes,
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

export const firstPartyOAuthCredentialSettings = (id: string) => {
  const prefix = `EXECUTOR_OAUTH_${id.toUpperCase().replaceAll("-", "_")}`;
  return { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` };
};

export const testDefinitionsSetting = "EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS";

const invalid = (problems: ReadonlyArray<string>) =>
  new FirstPartyOAuthClientsInvalid({
    message: `The operator's OAuth client settings are invalid. ${problems.join(" ")}`,
    problems,
  });

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
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Definitions))(
      Redacted.value(value.value),
    ).pipe(
      Effect.mapError((error) =>
        invalid([`${testDefinitionsSetting} is invalid: ${error.message}`]),
      ),
    );
  });

export type FirstPartyRegistrations = "executor" | "operator";

const forRegistrations = (
  definition: FirstPartyOAuthClientDefinition,
  registrations: FirstPartyRegistrations,
): FirstPartyOAuthClientDefinition => {
  const { heldScopes, ...menu } = definition;
  if (registrations === "executor" || heldScopes === undefined) return definition;
  return {
    ...menu,
    allowedScopes: [
      ...(menu.allowedScopes ?? menu.defaultScopes),
      ...heldScopes.map((held) => held.scope),
    ],
  };
};

export const firstPartyOAuthClients = (options: {
  readonly testDefinitions: boolean;
  readonly registrations: FirstPartyRegistrations;
}) =>
  Effect.gen(function* () {
    const reviewed = yield* Schema.decodeUnknownEffect(Definitions)(
      firstPartyOAuthClientDefinitions.map((definition) =>
        forRegistrations(definition, options.registrations),
      ),
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
      const client = yield* Schema.decodeUnknownEffect(Schema.toType(FirstPartyOAuthClient))({
        ...definition,
        clientId: Redacted.value(clientId.value),
        ...(Option.isSome(clientSecret) ? { clientSecret: clientSecret.value } : {}),
      }).pipe(Effect.option);
      if (Option.isNone(client)) {
        problems.push(`The ${definition.id} client's definition or client ID is invalid.`);
        continue;
      }
      clients.push(client.value);
    }
    if (problems.length > 0) return yield* invalid(problems);
    return clients;
  });
