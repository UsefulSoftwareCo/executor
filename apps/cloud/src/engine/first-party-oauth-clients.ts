import { FIGMA_SUPPORTED_OAUTH_SCOPES } from "@executor-js/plugin-openapi/presets";
import { googleCatalogOAuthScopesForPreset } from "@executor-js/plugin-openapi/providers/google";
import {
  MICROSOFT_AUTHORIZATION_URL,
  MICROSOFT_TOKEN_URL,
} from "@executor-js/plugin-openapi/providers/microsoft";
import { slackMcpUserScopes } from "@executor-js/react/lib/slack-mcp-oauth";
import { IntegrationSlug, type FirstPartyOAuthClientConfig } from "@executor-js/sdk";

/** Cloud secret bindings that enable host-operated OAuth clients. A provider
 *  is absent unless both values in its pair are present. */
export interface FirstPartyOAuthClientEnv {
  readonly FIRST_PARTY_AIRTABLE_CLIENT_ID?: string;
  readonly FIRST_PARTY_AIRTABLE_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_ATLASSIAN_CLIENT_ID?: string;
  readonly FIRST_PARTY_ATLASSIAN_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_BOX_CLIENT_ID?: string;
  readonly FIRST_PARTY_BOX_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_CLICKUP_CLIENT_ID?: string;
  readonly FIRST_PARTY_CLICKUP_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_FIGMA_CLIENT_ID?: string;
  readonly FIRST_PARTY_FIGMA_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_GITHUB_CLIENT_ID?: string;
  readonly FIRST_PARTY_GITHUB_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_GITHUB_AUTHORIZE_URL?: string;
  readonly FIRST_PARTY_GITHUB_TOKEN_URL?: string;
  readonly FIRST_PARTY_GITLAB_CLIENT_ID?: string;
  readonly FIRST_PARTY_GITLAB_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_GOOGLE_CLIENT_ID?: string;
  readonly FIRST_PARTY_GOOGLE_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_HUBSPOT_CLIENT_ID?: string;
  readonly FIRST_PARTY_HUBSPOT_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_LINEAR_CLIENT_ID?: string;
  readonly FIRST_PARTY_LINEAR_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_MICROSOFT_CLIENT_ID?: string;
  readonly FIRST_PARTY_MICROSOFT_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_NOTION_CLIENT_ID?: string;
  readonly FIRST_PARTY_NOTION_CLIENT_SECRET?: string;
  readonly FIRST_PARTY_SLACK_CLIENT_ID?: string;
  readonly FIRST_PARTY_SLACK_CLIENT_SECRET?: string;
}

const AIRTABLE_SCOPES = [
  "data.recordComments:read",
  "data.recordComments:write",
  "data.records:read",
  "data.records:write",
  "data.records:manage",
  "schema.bases:read",
  "schema.bases:write",
  "user.email:read",
  "workspacesAndBases:read",
  "workspacesAndBases:write",
  "workspacesAndBases.shares:manage",
  "webhook:manage",
] as const;

const ATLASSIAN_SCOPES = [
  "read:me",
  "read:account",
  "read:jira-work",
  "manage:jira-project",
  "manage:jira-configuration",
  "read:jira-user",
  "write:jira-work",
  "manage:jira-webhook",
  "read:servicedesk-request",
  "manage:servicedesk-customer",
  "write:servicedesk-request",
  "write:confluence-content",
  "read:confluence-space.summary",
  "write:confluence-space",
  "write:confluence-file",
  "read:confluence-props",
  "write:confluence-props",
  "manage:confluence-configuration",
  "read:confluence-content.all",
  "read:confluence-content.summary",
  "search:confluence",
  "read:confluence-content.permission",
  "read:confluence-user",
  "read:confluence-groups",
  "write:confluence-groups",
  "offline_access",
] as const;

const BOX_SCOPES = [
  "root_readonly",
  "root_readwrite",
  "sign_requests.readwrite",
  "ai.readwrite",
  "manage_webhook",
  "manage_triggers",
] as const;

const GITLAB_SCOPES = [
  "api",
  "read_api",
  "read_user",
  "create_runner",
  "manage_runner",
  "k8s_proxy",
  "mcp",
  "mcp_orbit",
  "read_repository",
  "write_repository",
  "read_registry",
  "write_registry",
  "read_virtual_registry",
  "write_virtual_registry",
  "read_observability",
  "write_observability",
  "ai_features",
  "openid",
  "profile",
  "email",
] as const;

const HUBSPOT_REQUIRED_SCOPES = [
  "oauth",
  "account-info.security.read",
  "cms.domains.read",
  "cms.domains.write",
  "crm.export",
  "crm.import",
  "crm.lists.read",
  "crm.lists.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.marketing_events.read",
  "crm.objects.marketing_events.write",
  "crm.objects.owners.read",
  "crm.objects.quotes.read",
  "crm.objects.quotes.write",
  "crm.schemas.companies.read",
  "crm.schemas.companies.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
  "sales-email-read",
  "settings.users.read",
  "settings.users.write",
  "tickets",
  "timeline",
] as const;

const HUBSPOT_OPTIONAL_SCOPES = [
  "content",
  "crm.objects.custom.read",
  "crm.schemas.custom.read",
] as const;

const MICROSOFT_SCOPES = [
  "User.Read",
  "Calendars.ReadWrite",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "Chat.ReadWrite",
  "Files.ReadWrite.All",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
  "OnlineMeetings.ReadWrite",
  "Sites.ReadWrite.All",
  "Team.ReadBasic.All",
  "offline_access",
] as const;

// Consumer Google launch boundary. Keep this list aligned with the scopes
// submitted for the Executor-owned production app: ordinary Workspace services
// plus Photos, Meet, and Search Console. Admin, Classroom, YouTube, Apps Script,
// BigQuery, and Cloud Resource Manager have materially different audiences or
// provider requirements and remain BYO OAuth. The same scope source builds each
// catalog auth template, preventing picker/start drift.
const GOOGLE_FIRST_PARTY_PRESET_IDS = [
  "google-calendar",
  "google-meet",
  "google-gmail",
  "google-sheets",
  "google-drive",
  "google-docs",
  "google-slides",
  "google-forms",
  "google-tasks",
  "google-people",
  "google-photos-library",
  "google-photos-picker",
  "google-search-console",
] as const;

const GOOGLE_ALLOWED_SCOPES: readonly string[] = [
  ...new Set([
    ...GOOGLE_FIRST_PARTY_PRESET_IDS.flatMap(googleCatalogOAuthScopesForPreset),
    // Connections created before the full-Gmail review retain this declared
    // scope on reconnect. New Gmail presets request `mail.google.com`.
    "https://www.googleapis.com/auth/gmail.modify",
  ]),
];

const client = (
  clientId: string | undefined,
  clientSecret: string | undefined,
  config: Omit<FirstPartyOAuthClientConfig, "clientId" | "clientSecret">,
): readonly FirstPartyOAuthClientConfig[] =>
  clientId && clientSecret ? [{ ...config, clientId, clientSecret }] : [];

/** Build the enabled first-party registry from secret bindings. Provider
 *  protocol details and scope ceilings live here so the cloud composition root
 *  cannot drift from the registered production clients.
 *
 *  Each provider-side registration must list
 *  `${VITE_PUBLIC_SITE_URL}/api/oauth/callback` as its callback; the org slug
 *  travels inside OAuth `state`, so the single static callback serves every
 *  org.
 *
 *  The endpoint URLs default to the real provider; the `_AUTHORIZE_URL` /
 *  `_TOKEN_URL` overrides exist so tests and dev instances can point the app at
 *  an emulated provider (`@executor-js/emulate`) and run the complete flow.
 *  Production leaves them unset. */
export const firstPartyOAuthClientsFor = (
  env: FirstPartyOAuthClientEnv,
): readonly FirstPartyOAuthClientConfig[] => [
  ...client(env.FIRST_PARTY_AIRTABLE_CLIENT_ID, env.FIRST_PARTY_AIRTABLE_CLIENT_SECRET, {
    name: "airtable",
    authorizationUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    tokenEndpointAuthMethod: "basic",
    authorizationScopes: AIRTABLE_SCOPES,
    allowedScopes: AIRTABLE_SCOPES,
  }),
  ...client(env.FIRST_PARTY_ATLASSIAN_CLIENT_ID, env.FIRST_PARTY_ATLASSIAN_CLIENT_SECRET, {
    name: "atlassian",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    tokenRequestFormat: "json",
    authorizationScopes: ATLASSIAN_SCOPES,
    allowedScopes: ATLASSIAN_SCOPES,
    authorizationExtraParams: { audience: "api.atlassian.com", prompt: "consent" },
  }),
  ...client(env.FIRST_PARTY_BOX_CLIENT_ID, env.FIRST_PARTY_BOX_CLIENT_SECRET, {
    name: "box",
    authorizationUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    authorizationScopes: BOX_SCOPES,
    allowedScopes: BOX_SCOPES,
  }),
  ...client(env.FIRST_PARTY_CLICKUP_CLIENT_ID, env.FIRST_PARTY_CLICKUP_CLIENT_SECRET, {
    name: "clickup",
    authorizationUrl: "https://app.clickup.com/api",
    tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
    tokenRequestFormat: "json",
    authorizationScopes: [],
  }),
  ...client(env.FIRST_PARTY_FIGMA_CLIENT_ID, env.FIRST_PARTY_FIGMA_CLIENT_SECRET, {
    name: "figma",
    authorizationUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    tokenEndpointAuthMethod: "basic",
    integrations: [IntegrationSlug.make("figma_api")],
    authorizationScopes: FIGMA_SUPPORTED_OAUTH_SCOPES,
    allowedScopes: FIGMA_SUPPORTED_OAUTH_SCOPES,
  }),
  ...client(env.FIRST_PARTY_GITHUB_CLIENT_ID, env.FIRST_PARTY_GITHUB_CLIENT_SECRET, {
    name: "github",
    authorizationUrl:
      env.FIRST_PARTY_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
    tokenUrl: env.FIRST_PARTY_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
    integrations: [IntegrationSlug.make("github_rest")],
    // GitHub App user access tokens do not use classic OAuth scopes; their
    // capabilities come from the app's registered permissions.
    authorizationScopes: [],
  }),
  ...client(env.FIRST_PARTY_GITLAB_CLIENT_ID, env.FIRST_PARTY_GITLAB_CLIENT_SECRET, {
    name: "gitlab",
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    authorizationScopes: GITLAB_SCOPES,
    allowedScopes: GITLAB_SCOPES,
  }),
  ...client(env.FIRST_PARTY_GOOGLE_CLIENT_ID, env.FIRST_PARTY_GOOGLE_CLIENT_SECRET, {
    name: "google",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    allowedScopes: GOOGLE_ALLOWED_SCOPES,
    // Withdrawn from the connect picker: no new connection is offered the
    // Executor-owned Google app. The entry stays declared on purpose — every
    // connection already minted against it keeps refreshing and reconnecting
    // through it. Deleting this block, or unsetting the env vars, would strand
    // those connections instead.
    unlisted: true,
  }),
  ...client(env.FIRST_PARTY_HUBSPOT_CLIENT_ID, env.FIRST_PARTY_HUBSPOT_CLIENT_SECRET, {
    name: "hubspot",
    authorizationUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v3/token",
    authorizationScopes: HUBSPOT_REQUIRED_SCOPES,
    allowedScopes: [...HUBSPOT_REQUIRED_SCOPES, ...HUBSPOT_OPTIONAL_SCOPES],
    authorizationExtraParams: { optional_scope: HUBSPOT_OPTIONAL_SCOPES.join(" ") },
  }),
  ...client(env.FIRST_PARTY_LINEAR_CLIENT_ID, env.FIRST_PARTY_LINEAR_CLIENT_SECRET, {
    name: "linear",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    authorizationScopes: ["read", "write"],
    authorizationScopeSeparator: ",",
    allowedScopes: ["read", "write"],
  }),
  ...client(env.FIRST_PARTY_MICROSOFT_CLIENT_ID, env.FIRST_PARTY_MICROSOFT_CLIENT_SECRET, {
    name: "microsoft",
    authorizationUrl: MICROSOFT_AUTHORIZATION_URL,
    tokenUrl: MICROSOFT_TOKEN_URL,
    allowedScopes: MICROSOFT_SCOPES,
    additionalAuthorizationScopes: ["offline_access"],
  }),
  ...client(env.FIRST_PARTY_NOTION_CLIENT_ID, env.FIRST_PARTY_NOTION_CLIENT_SECRET, {
    name: "notion",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    authorizationExtraParams: { owner: "user" },
    tokenEndpointAuthMethod: "basic",
    tokenRequestFormat: "json",
    authorizationScopes: [],
  }),
  ...client(env.FIRST_PARTY_SLACK_CLIENT_ID, env.FIRST_PARTY_SLACK_CLIENT_SECRET, {
    name: "slack",
    authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.user.access",
    resource: "https://mcp.slack.com",
    integrations: [IntegrationSlug.make("slack")],
    allowedScopes: slackMcpUserScopes,
  }),
];
