import { WorkflowRunId } from "../contracts/workflows.ts";
import { AppSlug } from "../contracts/app-slug.ts";
import { AccountScope } from "../contracts/apps.ts";
import { SourceCommit } from "../contracts/source.ts";
import {
  AccountId,
  WebhookId,
  AppId,
  AppCodeId,
  VersionId,
  BuildId,
  OwnerId,
  ProviderId,
  JsonObject,
  ToolName,
} from "../contracts/shared.ts";
import { AccountConnectionId, ApprovalRequestId } from "../contracts/shared.ts";
import { OAuthClientId, OAuthClientSource } from "../contracts/oauth.ts";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { Effect, Schema } from "effect";

const ProfileId = Schema.String;

export const version4Tables = {
  profiles: table("executor_installations", {
    id: idColumn("id", ProfileId, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    subject: column("subject", Schema.String, { type: "varchar(255)" }),
    name: column("name", Schema.NullOr(Schema.String), { type: "varchar(128)" }),
    idempotencyKey: column("idempotency_key", Schema.String, { type: "varchar(128)" }),
    accounts: column("accounts", Schema.Json),
    webhookConfig: column("webhook_config", Schema.Json),
    revision: column("revision", Schema.Int),
    enabled: column("enabled", Schema.Boolean),
    status: column("status", Schema.String, { type: "varchar(32)" }),
    failure: column("failure", Schema.NullOr(Schema.String)),
    reconciledDeployment: column("reconciled_deployment", Schema.NullOr(VersionId), {
      type: "varchar(255)",
    }),
    reconciledRevision: column("reconciled_revision", Schema.NullOr(Schema.Int)),
    request: column("request", Schema.Json),
    lease: column("lease", Schema.NullOr(Schema.String)),
    leaseUntil: column("lease_until", Schema.Date),
    createdAt: column("created_at", Schema.Date),
  }).unique("executor_installations_request", ["app", "subject", "idempotencyKey"]),
  workflowRuns: table("executor_workflow_runs", {
    id: idColumn("id", WorkflowRunId, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    profile: column("installation", Schema.NullOr(ProfileId), {
      type: "varchar(255)",
    }).default(null),
    profileRevision: column("installation_revision", Schema.NullOr(Schema.Int)).default(null),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    key: column("start_key", Schema.String, { type: "varchar(128)" }),
    deployment: column("deployment", VersionId, { type: "varchar(255)" }),
    name: column("name", Schema.String),
    accounts: column("accounts", Schema.Json),
    status: column("status", Schema.String),
    failure: column("failure", Schema.NullOr(Schema.String)),
    encrypted: column("encrypted", Schema.Uint8Array),
    createdAt: column("created_at", Schema.Date),
  }),
  workflowAccounts: table("executor_workflow_accounts", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    account: column("account", AccountId, { type: "varchar(255)" }),
    run: column("run", WorkflowRunId, { type: "varchar(255)" }),
  }).unique("executor_workflow_accounts_account_run", ["account", "run"]),
  schedules: table("executor_schedules", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    profile: column("installation", Schema.NullOr(ProfileId), {
      type: "varchar(255)",
    }).default(null),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    name: column("name", Schema.String, { type: "varchar(255)" }),
    actor: column("actor", Schema.String, { type: "varchar(255)" }),
    timing: column("timing", Schema.Json),
    enabled: column("enabled", Schema.Boolean),
    approvalMode: column("approval_mode", Schema.String, { type: "varchar(32)" }),
    nextAt: column("next_at", Schema.NullOr(Schema.Date)),
    activeRun: column("active_run", Schema.NullOr(Schema.String), { type: "varchar(255)" }),
    revision: column("revision", Schema.String, { type: "varchar(255)" }),
  }),
  scheduledRuns: table("executor_scheduled_runs", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    scheduleId: column("schedule_id", Schema.String, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    profile: column("installation", Schema.NullOr(ProfileId), {
      type: "varchar(255)",
    }).default(null),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    name: column("name", Schema.String),
    status: column("status", Schema.String, { type: "varchar(32)" }),
    scheduledAt: column("scheduled_at", Schema.Date),
    startedAt: column("started_at", Schema.Date),
    finishedAt: column("finished_at", Schema.NullOr(Schema.Date)),
    requestId: column("request_id", Schema.NullOr(ApprovalRequestId), { type: "varchar(255)" }),
    expiresAt: column("expires_at", Schema.NullOr(Schema.Date)),
    failure: column("failure", Schema.NullOr(Schema.String)),
    runner: column("runner", Schema.String, { type: "varchar(255)" }),
    revision: column("revision", Schema.String, { type: "varchar(255)" }),
    answer: column("answer", Schema.NullOr(Schema.String), { type: "varchar(32)" }),
  }),
  providers: table("executor_providers", {
    id: idColumn("id", ProviderId, { type: "varchar(255)" }),
    definition: column("definition", Schema.Json),
  }),
  accounts: table("executor_accounts", {
    id: idColumn("id", AccountId, { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    provider: column("provider", ProviderId, { type: "varchar(255)" }),
    method: column("method", Schema.String),
    label: column("label", Schema.String),
    encryptedCredentials: column("encrypted_credentials", Schema.Uint8Array),
    createdAt: column("created_at", Schema.Date),
  }),
  deployments: table("executor_deployments", {
    id: idColumn("id", VersionId, { type: "varchar(255)" }),
    code: column("code", AppCodeId, { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    build: column("build", BuildId, { type: "varchar(255)" }),
    requirements: column("requirements", Schema.Json),
    createdAt: column("created_at", Schema.Date),
    sourceCommit: column("source_commit", Schema.NullOr(SourceCommit), { type: "varchar(40)" }),
    fileCount: column("file_count", Schema.Int),
  }).unique("executor_deployments_id_code", ["id", "code"]),
  apps: table("executor_apps", {
    deploySequence: column("deploy_sequence", Schema.Int).default(0),
    activatedSequence: column("activated_sequence", Schema.Int).default(0),
    id: idColumn("id", AppId, { type: "varchar(255)" }),
    code: column("code", AppCodeId, { type: "varchar(255)" }),
    repository: column("repository", Schema.NullOr(AppCodeId), { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    name: column("name", Schema.String, { type: "varchar(255)" }),
    activeDeployment: column("active_deployment", Schema.NullOr(VersionId), {
      type: "varchar(255)",
    }),
    copiedFrom: column("copied_from", Schema.NullOr(Schema.Json)),
    createdAt: column("created_at", Schema.Date),
    slug: column("slug", AppSlug, { type: "varchar(63)" }),
  })
    .unique("executor_apps_owner_name", ["owner", "name"])
    .unique("executor_apps_owner_slug", ["owner", "slug"]),
  oauthClients: table("executor_oauth_clients", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    encrypted: column("encrypted", Schema.Uint8Array),
  }),
  oauthAttempts: table("executor_oauth_attempts", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    encrypted: column("encrypted", Schema.Uint8Array),
    expiresAt: column("expires_at", Schema.Date),
    status: column("status", Schema.String),
  }),
  oauthGrants: table("executor_oauth_grants", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    encrypted: column("encrypted", Schema.Uint8Array),
    status: column("status", Schema.String),
    updatedAt: column("updated_at", Schema.Date),
  }),
  appRecords: table("executor_app_records", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    table: column("table_name", Schema.String, { type: "varchar(255)" }),
    key: column("record_key", Schema.String, { type: "varchar(255)" }),
    value: column("value", JsonObject),
  }).unique("executor_app_records_app_table_key", ["app", "table", "key"]),
  accountConnections: table("executor_account_connections", {
    id: idColumn("id", AccountConnectionId, { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    provider: column("provider", ProviderId, { type: "varchar(255)" }),
    reconnectAccount: column("reconnect_account", Schema.NullOr(AccountId), {
      type: "varchar(255)",
    }),
    state: column("state", Schema.Json),
    revision: column("revision", Schema.String, { type: "varchar(255)" }),
    oauthAttempt: column("oauth_attempt", Schema.NullOr(Schema.String), { type: "varchar(255)" }),
    createdAt: column("created_at", Schema.Date),
    expiresAt: column("expires_at", Schema.Date),
    target: column("target", Schema.NullOr(Schema.Json)).default(null),
  }),
  toolApprovals: table("executor_tool_approvals", {
    id: idColumn("id", ApprovalRequestId, { type: "varchar(255)" }),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    status: column("status", Schema.String, { type: "varchar(255)" }),
    revision: column("revision", Schema.String, { type: "varchar(255)" }),
    encrypted: column("encrypted", Schema.Uint8Array),
    expiresAt: column("expires_at", Schema.Date),
  }),
  webhookAccounts: table("executor_webhook_accounts", {
    id: idColumn("id", Schema.String, { type: "varchar(255)" }),
    account: column("account", AccountId, { type: "varchar(255)" }),
    subscription: column("subscription", WebhookId, { type: "varchar(255)" }),
  })
    .unique("executor_webhook_accounts_account_subscription", ["account", "subscription"])
    .unique("executor_webhook_accounts_subscription_account", ["subscription", "account"]),
  webhooks: table("executor_webhooks", {
    id: idColumn("id", WebhookId, { type: "varchar(255)" }),
    app: column("app", AppId, { type: "varchar(255)" }),
    profile: column("installation", Schema.NullOr(ProfileId), {
      type: "varchar(255)",
    }).default(null),
    profileRevision: column("installation_revision", Schema.NullOr(Schema.Int)).default(null),
    owner: column("owner", OwnerId, { type: "varchar(255)" }),
    key: column("subscription_key", Schema.String, { type: "varchar(128)" }),
    deployment: column("deployment", VersionId, { type: "varchar(255)" }),
    name: column("name", Schema.String),
    sourceAccount: column("source_account", AccountId, { type: "varchar(255)" }),
    callbackUrl: column("callback_url", Schema.String),
    accounts: column("accounts", Schema.Json),
    status: column("status", Schema.String, { type: "varchar(32)" }),
    revision: column("revision", Schema.String, { type: "varchar(255)" }),
    leaseUntil: column("lease_until", Schema.Date),
    failure: column("failure", Schema.NullOr(Schema.String)),
    encrypted: column("encrypted", Schema.Uint8Array),
    createdAt: column("created_at", Schema.Date),
  }),
};

const accounts = table("executor_accounts", {
  id: idColumn("id", AccountId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", ProviderId, { type: "varchar(255)" }),
  method: column("method", Schema.String),
  label: column("label", Schema.String),
  encryptedCredentials: column("encrypted_credentials", Schema.Uint8Array),
  credentialGeneration: column("credential_generation", Schema.Int).default(0),
  createdAt: column("created_at", Schema.Date),
});

export const version402Tables = { ...version4Tables, accounts };

const accountChecks = table("executor_account_checks", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  account: column("account", AccountId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  deployment: column("deployment", VersionId, { type: "varchar(255)" }),
  credentialGeneration: column("credential_generation", Schema.Int),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  checkedAt: column("checked_at", Schema.Date),
  info: column("account_info", Schema.NullOr(Schema.Json)).default(null),
  infoCheckedAt: column("info_checked_at", Schema.NullOr(Schema.Date)).default(null),
}).unique("executor_account_checks_account_app", ["account", "app"]);

export const version403Tables = { ...version402Tables, accountChecks };

const describedAccounts = table("executor_accounts", {
  ...accounts.columns,
  description: column("description", Schema.NullOr(Schema.String)).default(null),
});

export const version404Tables = { ...version403Tables, accounts: describedAccounts };

const grantedAccounts = table("executor_accounts", {
  ...describedAccounts.columns,
  allowedHosts: column("allowed_hosts", Schema.NullOr(Schema.Json)).default(null),
});

export const version405Tables = { ...version404Tables, accounts: grantedAccounts };

const explainedAccountChecks = table("executor_account_checks", {
  ...accountChecks.columns,
  message: column("message", Schema.NullOr(Schema.String)).default(null),
});

export const version406Tables = { ...version405Tables, accountChecks: explainedAccountChecks };

const eventSubscriptions = table("executor_event_subscriptions", {
  id: idColumn("id", Schema.String, { type: "varchar(64)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  event: column("event", Schema.String, { type: "varchar(64)" }),
  name: column("name", Schema.String, { type: "varchar(255)" }),
  arguments: column("arguments", Schema.Json),
  callbackUrl: column("callback_url", Schema.String),
  principal: column("principal", Schema.String, { type: "varchar(255)" }),
  subject: column("subject", Schema.String, { type: "varchar(255)" }),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  stopped: column("stopped", Schema.NullOr(Schema.String), { type: "varchar(32)" }),
  expiresAt: column("expires_at", Schema.Date),
  verifiedAt: column("verified_at", Schema.Date),
  revision: column("revision", Schema.String, { type: "varchar(64)" }),
  encrypted: column("encrypted", Schema.Uint8Array),
  createdAt: column("created_at", Schema.Date),
});
const events = table("executor_events", {
  id: idColumn("id", Schema.String, { type: "varchar(64)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  name: column("name", Schema.String, { type: "varchar(64)" }),
  eventId: column("event_id", Schema.String, { type: "varchar(255)" }),
  account: column("account", Schema.NullOr(AccountId), { type: "varchar(255)" }),
  accounts: column("accounts", Schema.Json),
  occurredAt: column("occurred_at", Schema.Date),
  encrypted: column("encrypted", Schema.Uint8Array),
  createdAt: column("created_at", Schema.Date),
}).unique("executor_events_app_name_event", ["app", "name", "eventId"]);
const eventDeliveries = table("executor_event_deliveries", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  subscription: column("subscription", Schema.String, { type: "varchar(64)" }),
  event: column("event", Schema.String, { type: "varchar(64)" }),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  attempts: column("attempts", Schema.Int),
  nextAt: column("next_at", Schema.Date),
  lease: column("lease", Schema.NullOr(Schema.String), { type: "varchar(64)" }),
  leaseUntil: column("lease_until", Schema.Date),
  lastError: column("last_error", Schema.NullOr(Schema.String), { type: "varchar(32)" }),
  createdAt: column("created_at", Schema.Date),
  finishedAt: column("finished_at", Schema.NullOr(Schema.Date)),
}).unique("executor_event_deliveries_subscription_event", ["subscription", "event"]);

export const version407Tables = {
  ...version406Tables,
  eventSubscriptions,
  events,
  eventDeliveries,
};

export const eventIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_due ON executor_event_deliveries (status, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_event_subscriptions_app_event ON executor_event_subscriptions (app, event, status)",
  "CREATE INDEX IF NOT EXISTS executor_event_subscriptions_principal_url ON executor_event_subscriptions (principal, callback_url)",
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_age ON executor_event_deliveries (status, created_at)",
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_finished ON executor_event_deliveries (finished_at)",
  "CREATE INDEX IF NOT EXISTS executor_events_created ON executor_events (created_at)",
] as const;

const targetedConnections = table("executor_account_connections", {
  ...version4Tables.accountConnections.columns,
  target: column("target", Schema.Json),
});

export const version408Tables = { ...version407Tables, accountConnections: targetedConnections };

const targetless = "target IS NULL OR json_typeof(target) = 'null'";
export const targetlessConnectionCleanup = [
  `DELETE FROM executor_oauth_attempts WHERE id IN (
    SELECT oauth_attempt FROM executor_account_connections
    WHERE (${targetless}) AND oauth_attempt IS NOT NULL)`,
  `DELETE FROM executor_account_connections WHERE ${targetless}`,
] as const;

export const version408Schema = schema({
  version: "4.0.8",
  tables: version408Tables,
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...targetlessConnectionCleanup.map((sql) => ({ type: "custom" as const, sql })),
        ...operations,
      ]),
    ),
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

const toolSearchListings = table("executor_tool_search_listings", {
  listing: idColumn("listing", Schema.String, { type: "varchar(64)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  deployment: column("deployment", VersionId, { type: "varchar(255)" }),
  profile: column("profile", Schema.NullOr(ProfileId), { type: "varchar(255)" }).default(null),
  at: column("at", Schema.BigInt),
  digest: column("digest", Schema.String, { type: "varchar(64)" }),
  routers: column("routers", Schema.Json),
  superseded: column("superseded", Schema.NullOr(Schema.BigInt)).default(null),
});
const toolSearch = table("executor_tool_search", {
  id: idColumn("id", Schema.String, { type: "varchar(80)" }),
  listing: column("listing", Schema.String, { type: "varchar(64)" }),
  name: column("name", ToolName),
  readOnly: column("read_only", Schema.Boolean),
  terms: column("terms", Schema.String),
  length: column("length", Schema.Int),
  signature: column("signature", Schema.String, { type: "varchar(64)" }),
  tool: column("tool", Schema.Json),
  definitions: column("definitions", Schema.Json),
});
const toolSearchDefinitions = table("executor_tool_search_definitions", {
  id: idColumn("id", Schema.String, { type: "varchar(80)" }),
  listing: column("listing", Schema.String, { type: "varchar(64)" }),
  position: column("position", Schema.Int),
  definition: column("definition", Schema.Json),
});

export const version409Tables = {
  ...version408Tables,
  toolSearchListings,
  toolSearch,
  toolSearchDefinitions,
};

export const toolSearchIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listing ON executor_tool_search (listing)",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_terms ON executor_tool_search USING gin ((string_to_array(terms, ' ')))",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listings_target ON executor_tool_search_listings (app, profile)",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_definitions_listing ON executor_tool_search_definitions (listing)",
] as const;

export const version409Schema = schema({
  version: "4.0.9",
  tables: version409Tables,
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...operations,
        ...toolSearchIndexes.map((sql) => ({ type: "custom" as const, sql })),
      ]),
    ),
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

export const CredentialsWithdrawal = Schema.Literals(["removed", "expired", "rejected"]);

const storedOAuthClients = table("executor_stored_oauth_clients", {
  id: idColumn("id", OAuthClientId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", ProviderId, { type: "varchar(255)" }),
  clientId: column("client_id", Schema.String),
  source: column("source", OAuthClientSource, { type: "varchar(32)" }),
  hasSecret: column("has_secret", Schema.Boolean),
  automaticKey: column("automatic_key", Schema.NullOr(Schema.String), {
    type: "varchar(255)",
  }).default(null),
  confirmed: column("confirmed", Schema.Boolean).default(false),
  encrypted: column("encrypted", Schema.Uint8Array),
  createdAt: column("created_at", Schema.Date),
});

const storedOAuthClientCredentials = table("executor_stored_oauth_client_credentials", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", ProviderId, { type: "varchar(255)" }),
  client: column("client", OAuthClientId, { type: "varchar(255)" }),
  withdrawal: column("withdrawal", Schema.NullOr(CredentialsWithdrawal), {
    type: "varchar(32)",
  }).default(null),
  createdAt: column("created_at", Schema.Date),
});

export const version4010Tables = {
  ...version409Tables,
  storedOAuthClients,
  storedOAuthClientCredentials,
};

export const storedOAuthClientIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_provider ON executor_stored_oauth_clients (owner, provider)",
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_key ON executor_stored_oauth_clients (owner, automatic_key)",
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_client_credentials_owner ON executor_stored_oauth_client_credentials (owner)",
] as const;

export const version4010Schema = schema({
  version: "4.0.10",
  tables: version4010Tables,
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...operations,
        ...storedOAuthClientIndexes.map((sql) => ({ type: "custom" as const, sql })),
      ]),
    ),
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

export const boundedReadIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_accounts_owner_id ON executor_accounts (owner, id)",
  "CREATE INDEX IF NOT EXISTS executor_installations_owner_app ON executor_installations (owner, app)",
  "CREATE INDEX IF NOT EXISTS executor_deployments_code_created ON executor_deployments (code, created_at)",
] as const;

const storedOAuthClientsByIssuer = table("executor_stored_oauth_clients", {
  id: idColumn("id", OAuthClientId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", Schema.NullOr(ProviderId), { type: "varchar(255)" }).default(null),
  issuer: column("issuer", Schema.NullOr(Schema.String)).default(null),
  clientId: column("client_id", Schema.String),
  source: column("source", OAuthClientSource, { type: "varchar(32)" }),
  hasSecret: column("has_secret", Schema.Boolean),
  automaticKey: column("automatic_key", Schema.NullOr(Schema.String), {
    type: "varchar(255)",
  }).default(null),
  confirmed: column("confirmed", Schema.Boolean).default(false),
  encrypted: column("encrypted", Schema.Uint8Array),
  createdAt: column("created_at", Schema.Date),
});

const storedOAuthClientCredentialsByIssuer = table("executor_stored_oauth_client_credentials", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", Schema.NullOr(ProviderId), { type: "varchar(255)" }).default(null),
  client: column("client", OAuthClientId, { type: "varchar(255)" }),
  withdrawal: column("withdrawal", Schema.NullOr(CredentialsWithdrawal), {
    type: "varchar(32)",
  }).default(null),
  createdAt: column("created_at", Schema.Date),
});

export const version4012Tables = {
  ...version409Tables,
  storedOAuthClients: storedOAuthClientsByIssuer,
  storedOAuthClientCredentials: storedOAuthClientCredentialsByIssuer,
};

export const storedOAuthClientIssuerIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_issuer ON executor_stored_oauth_clients (owner, issuer)",
] as const;

export const version4012Schema = schema({
  version: "4.0.12",
  tables: version4012Tables,
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...operations,
        ...storedOAuthClientIssuerIndexes.map((sql) => ({ type: "custom" as const, sql })),
      ]),
    ),
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

const actorWorkflowRuns = table("executor_workflow_runs", {
  ...version4Tables.workflowRuns.columns,
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
});
const actorWebhooks = table("executor_webhooks", {
  ...version4Tables.webhooks.columns,
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
  registeredActor: column("registered_actor", Schema.NullOr(Schema.String), {
    type: "varchar(255)",
  }).default(null),
  registeredAccounts: column("registered_accounts", Schema.NullOr(Schema.Json)).default(null),
});
const webhookSources = table("executor_webhook_sources", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  account: column("account", AccountId, { type: "varchar(255)" }),
  actor: column("actor", Schema.String, { type: "varchar(255)" }),
  accounts: column("accounts", Schema.Json),
  config: column("config", Schema.Json),
  revision: column("revision", Schema.Int),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  failure: column("failure", Schema.NullOr(Schema.String), { type: "varchar(32)" }),
  reconciledDeployment: column("reconciled_deployment", Schema.NullOr(VersionId), {
    type: "varchar(255)",
  }),
  lease: column("lease", Schema.NullOr(Schema.String), { type: "varchar(255)" }),
  leaseUntil: column("lease_until", Schema.Date),
  createdAt: column("created_at", Schema.Date),
}).unique("executor_webhook_sources_app_account", ["app", "account"]);

const profileAppCopies = table("executor_profile_app_copies", {
  id: idColumn("id", AppId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  subject: column("subject", Schema.String, { type: "varchar(255)" }),
  label: column("label", Schema.String, { type: "varchar(128)" }),
  profiles: column("profiles", Schema.Json),
  accounts: column("accounts", Schema.Json),
  webhookConfig: column("webhook_config", Schema.Json),
  enable: column("enable", Schema.Json),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  createdAt: column("created_at", Schema.Date),
});

const targetedToolSearchListings = table("executor_tool_search_listings", {
  ...toolSearchListings.columns,
  target: column("target", Schema.NullOr(Schema.String), { type: "varchar(64)" }).default(null),
});

export const version4013Tables = {
  ...version4012Tables,
  workflowRuns: actorWorkflowRuns,
  webhooks: actorWebhooks,
  webhookSources,
  toolSearchListings: targetedToolSearchListings,
  profileAppCopies,
};

export const toolSearchTargetIndex =
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listings_accounts ON executor_tool_search_listings (app, target)";

const appScopeSchedules = table("executor_schedules", {
  ...version4013Tables.schedules.columns,
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
});
const appScopeWebhookSources = table("executor_webhook_sources", {
  ...webhookSources.columns,
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
}).unique("executor_webhook_sources_app_account", ["app", "account"]);

const scopedWorkflowRuns = table("executor_workflow_runs", {
  ...actorWorkflowRuns.columns,
  scope: column("scope", AccountScope, { type: "varchar(16)" }).default("user"),
});

export const version4014Tables = {
  ...version4013Tables,
  schedules: appScopeSchedules,
  webhookSources: appScopeWebhookSources,
  workflowRuns: scopedWorkflowRuns,
};

const retriedWebhookSources = table("executor_webhook_sources", {
  ...appScopeWebhookSources.columns,
  retries: column("retries", Schema.Int).default(0),
}).unique("executor_webhook_sources_app_account", ["app", "account"]);

/** Tables of the 4.0.15 layout; 4.0.16 only adds indexes. */
export const version4015Tables = {
  ...version4014Tables,
  webhookSources: retriedWebhookSources,
};

/**
 * Start keys are unique per app, actor and scope from 4.0.14, so a run started without a caller
 * and one started with a caller never share a key. It replaces `executor_workflow_runs_context_key`.
 */
export const scopedRunKeyIndex =
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_scope_key ON executor_workflow_runs (app, COALESCE(actor, ''), COALESCE(installation, ''), scope, start_key)";

export const appScheduleIndex =
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_app ON executor_schedules (app, name) WHERE actor IS NULL";

export const queueReadIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_webhook_sources_intent ON executor_webhook_sources (lease_until) WHERE status = 'pending' AND lease IS NULL",
  "CREATE INDEX IF NOT EXISTS executor_webhook_sources_retry ON executor_webhook_sources (lease_until) WHERE status <> 'ready'",
  "CREATE INDEX IF NOT EXISTS executor_account_checks_account_app ON executor_account_checks (account, app)",
] as const;

const selectingEventSubscriptions = table("executor_event_subscriptions", {
  ...eventSubscriptions.columns,
  app: column("app", Schema.NullOr(AppId), { type: "varchar(255)" }).default(null),
  event: column("event", Schema.NullOr(Schema.String), { type: "varchar(64)" }).default(null),
  selection: column("selection", Schema.NullOr(Schema.Json)).default(null),
});

export const version4017Tables = {
  ...version4015Tables,
  eventSubscriptions: selectingEventSubscriptions,
};

export const eventSelectionIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_event_subscriptions_owner_selection ON executor_event_subscriptions (owner, status) WHERE app IS NULL",
] as const;

/**
 * Version 4.0.18 records each provider's identity: its ID as the definition hashes without display
 * text. Rows stored before then have IDs that hashed labels too, so a deploy finds the provider a
 * definition already has by this column. Null on rows no deploy or data step has recorded yet.
 */
const identifiedProviders = table("executor_providers", {
  ...version4017Tables.providers.columns,
  identity: column("identity", Schema.NullOr(ProviderId), { type: "varchar(255)" }).default(null),
});

/** Tables of the 4.0.18 layout; 4.0.19 only adds the provider identity index. */
export const version4018Tables = {
  ...version4017Tables,
  providers: identifiedProviders,
};

/** Providers by identity, which each deploy reads. Added in 4.0.19. */
export const providerIdentityIndex =
  "CREATE INDEX IF NOT EXISTS executor_providers_identity ON executor_providers (identity)";
