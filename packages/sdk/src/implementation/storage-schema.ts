import { WorkflowRunId } from "../contracts/workflows.ts";
import { AppSlug } from "../contracts/app-slug.ts";
/** Current application schema. Upgrade history is registered separately. */
import { SourceCommit } from "../contracts/source.ts";
import {
  AccountId,
  WebhookId,
  AppId,
  ProfileId,
  AppCodeId,
  DeploymentId,
  BuildId,
  OwnerId,
  ProviderId,
  JsonObject,
} from "../contracts/shared.ts";
import { AccountConnectionId, ApprovalRequestId } from "../contracts/shared.ts";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { Effect, Schema } from "effect";

/**
 * Tables of the 4.0.0 and 4.0.1 layouts. Table definitions carry no relations until a schema
 * version attaches them, so every version can share these objects.
 */
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
    reconciledDeployment: column("reconciled_deployment", Schema.NullOr(DeploymentId), {
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
    deployment: column("deployment", DeploymentId, { type: "varchar(255)" }),
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
    id: idColumn("id", DeploymentId, { type: "varchar(255)" }),
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
    activeDeployment: column("active_deployment", Schema.NullOr(DeploymentId), {
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
    deployment: column("deployment", DeploymentId, { type: "varchar(255)" }),
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

/** Version 4.0.2 counts credential generations so caches can key on accounts, not credentials. */
const accounts = table("executor_accounts", {
  id: idColumn("id", AccountId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  provider: column("provider", ProviderId, { type: "varchar(255)" }),
  method: column("method", Schema.String),
  label: column("label", Schema.String),
  encryptedCredentials: column("encrypted_credentials", Schema.Uint8Array),
  /**
   * Counts connections, not tokens. Reconnecting or replacing credentials increments it; token
   * renewal does not. Caches key on the account and this value, never on credentials.
   */
  credentialGeneration: column("credential_generation", Schema.Int).default(0),
  createdAt: column("created_at", Schema.Date),
});

/** Tables of the 4.0.2 layout. */
export const version402Tables = { ...version4Tables, accounts };

/**
 * Version 4.0.3 records each app's latest check of an account, one row per account and app. A
 * result is current only for the credential generation and deployment it names. Display info is
 * kept from the last passing check, with its own time, when a later check fails.
 */
const accountChecks = table("executor_account_checks", {
  id: idColumn("id", Schema.String, { type: "varchar(255)" }),
  account: column("account", AccountId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  deployment: column("deployment", DeploymentId, { type: "varchar(255)" }),
  credentialGeneration: column("credential_generation", Schema.Int),
  status: column("status", Schema.String, { type: "varchar(32)" }),
  checkedAt: column("checked_at", Schema.Date),
  info: column("account_info", Schema.NullOr(Schema.Json)).default(null),
  infoCheckedAt: column("info_checked_at", Schema.NullOr(Schema.Date)).default(null),
}).unique("executor_account_checks_account_app", ["account", "app"]);

/** Tables of the 4.0.3 layout. */
export const version403Tables = { ...version402Tables, accountChecks };

/**
 * Version 4.0.4 adds an account description: free text agents read with the account's label to
 * choose between accounts. Existing accounts have none.
 */
const describedAccounts = table("executor_accounts", {
  ...accounts.columns,
  description: column("description", Schema.NullOr(Schema.String)).default(null),
});

/** Tables of the 4.0.4 layout. */
export const version404Tables = { ...version403Tables, accounts: describedAccounts };

/**
 * Version 4.0.5 records the hosts each account was connected for. Null for accounts connected
 * without declared hosts, which allow whatever an app declares.
 */
const grantedAccounts = table("executor_accounts", {
  ...describedAccounts.columns,
  /**
   * The hosts the account's secret values may be sent to, as declared by the app it was connected
   * for. An app sends them only to the hosts it declares as well. See credential-handles.ts.
   */
  allowedHosts: column("allowed_hosts", Schema.NullOr(Schema.Json)).default(null),
});

/** Tables of the 4.0.5 layout. */
export const version405Tables = { ...version404Tables, accounts: grantedAccounts };

/**
 * Version 4.0.6 keeps why the latest check failed, as the app or host explained it, with account
 * secrets already replaced. Null for passing checks and for checks recorded before this version.
 */
const explainedAccountChecks = table("executor_account_checks", {
  ...accountChecks.columns,
  message: column("message", Schema.NullOr(Schema.String)).default(null),
});

/** Tables of the 4.0.6 layout. */
export const version406Tables = { ...version405Tables, accountChecks: explainedAccountChecks };

/**
 * Version 4.0.7 adds app events. A subscription is keyed by a digest of its subscriber, callback,
 * event name and arguments; its signing secrets are encrypted. Each emitted event is saved once,
 * encrypted, with one delivery per matching subscription.
 */
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
  /** Changes on every write; a refresh writes only over the row it computed from. */
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
  /** Every account bound to the emitting invocation. */
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
  /** The attempt that holds the delivery; completions must name it. */
  lease: column("lease", Schema.NullOr(Schema.String), { type: "varchar(64)" }),
  leaseUntil: column("lease_until", Schema.Date),
  lastError: column("last_error", Schema.NullOr(Schema.String), { type: "varchar(32)" }),
  createdAt: column("created_at", Schema.Date),
  finishedAt: column("finished_at", Schema.NullOr(Schema.Date)),
}).unique("executor_event_deliveries_subscription_event", ["subscription", "event"]);

/** Tables of the 4.0.7 layout. */
export const version407Tables = {
  ...version406Tables,
  eventSubscriptions,
  events,
  eventDeliveries,
};

/** Indexes added with app events in 4.0.7, created in the same step as their tables. */
export const eventIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_due ON executor_event_deliveries (status, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_event_subscriptions_app_event ON executor_event_subscriptions (app, event, status)",
  "CREATE INDEX IF NOT EXISTS executor_event_subscriptions_principal_url ON executor_event_subscriptions (principal, callback_url)",
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_age ON executor_event_deliveries (status, created_at)",
  "CREATE INDEX IF NOT EXISTS executor_event_deliveries_finished ON executor_event_deliveries (finished_at)",
  "CREATE INDEX IF NOT EXISTS executor_events_created ON executor_events (created_at)",
] as const;

/** Current ORM layout. Profiles own account selections; apps declare requirements. */
export const storageSchema = schema({
  version: "4.0.7",
  tables: version407Tables,
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...operations,
        ...eventIndexes.map((sql) => ({ type: "custom" as const, sql })),
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
