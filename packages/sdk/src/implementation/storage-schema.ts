import { WorkflowRunId } from "../contracts/workflows.ts";
import { AppSlug } from "../contracts/app-slug.ts";
import { AccountScope } from "../contracts/apps.ts";
/** Table layouts of each schema version. Versions and upgrades are registered in storage-migrations.ts. */
import { SourceCommit } from "../contracts/source.ts";
import {
  AccountId,
  WebhookId,
  AppId,
  AppCodeId,
  DeploymentId,
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

/**
 * The retired profile identity, `ins_`. Version 4.0.13 converted the SDK rows that named a profile;
 * the product reads the profile table once to link accounts, and a later version drops it.
 */
const ProfileId = Schema.String;

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
  /**
   * Saved clients of versions before 4.0.10, keyed by a digest of the sign-in settings. No longer
   * read or written once `executor_stored_oauth_clients` replaces it; a later release drops it.
   */
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

/**
 * Version 4.0.8 requires every connection to name the app profile requirement it fills. Before it,
 * provider-only requests, account-level reconnects and 1.3.0-era requests stored no target.
 */
const targetedConnections = table("executor_account_connections", {
  ...version4Tables.accountConnections.columns,
  target: column("target", Schema.Json),
});

/** Tables of the 4.0.8 layout. */
export const version408Tables = { ...version407Tables, accountConnections: targetedConnections };

/**
 * Removes the connections that have no target, and the pending sign-ins they point at, before the
 * column becomes required. A missing target is SQL null when a server wrote it and JSON null when
 * the column's old default filled it. Owner removal deletes a connection's sign-in the same way.
 * Nothing else references a connection: hosted access rows cascade with it, and accounts a
 * completed connection saved are kept. Servers since #2135 cannot create one.
 */
const targetless = "target IS NULL OR json_typeof(target) = 'null'";
export const targetlessConnectionCleanup = [
  `DELETE FROM executor_oauth_attempts WHERE id IN (
    SELECT oauth_attempt FROM executor_account_connections
    WHERE (${targetless}) AND oauth_attempt IS NOT NULL)`,
  `DELETE FROM executor_account_connections WHERE ${targetless}`,
] as const;

/** The 4.0.8 layout. Profiles own account selections; apps declare requirements. */
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

/**
 * Version 4.0.9 keeps evaluated tool listings as search rows: one row per listing, keyed by its
 * declaration key, one per tool with the words search ranks it by, and one per distinct `$defs`
 * entry the listing's schemas share, which tool rows name by position as the durable listing
 * text does. The rows are derived from listings and never read by an earlier server; losing them
 * costs only reading a listing again.
 */
const toolSearchListings = table("executor_tool_search_listings", {
  listing: idColumn("listing", Schema.String, { type: "varchar(64)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  app: column("app", AppId, { type: "varchar(255)" }),
  deployment: column("deployment", DeploymentId, { type: "varchar(255)" }),
  profile: column("profile", Schema.NullOr(ProfileId), { type: "varchar(255)" }).default(null),
  /** When the evaluation that produced the listing started, in epoch milliseconds. */
  at: column("at", Schema.BigInt),
  /** Changes when any row derived from the listing would; an equal digest is not rewritten. */
  digest: column("digest", Schema.String, { type: "varchar(64)" }),
  routers: column("routers", Schema.Json),
  /**
   * When a newer listing of the same app and profile was written, in epoch milliseconds, or null
   * while none was. Superseded rows are kept for as long as an execution may still search them.
   */
  superseded: column("superseded", Schema.NullOr(Schema.BigInt)).default(null),
});
const toolSearch = table("executor_tool_search", {
  /** The listing and the tool's position in it, which rewriting a listing replaces as a whole. */
  id: idColumn("id", Schema.String, { type: "varchar(80)" }),
  listing: column("listing", Schema.String, { type: "varchar(64)" }),
  name: column("name", ToolName),
  readOnly: column("read_only", Schema.Boolean),
  /** Space-separated words, as the SDK's search tokenizer produces them. */
  terms: column("terms", Schema.String),
  length: column("length", Schema.Int),
  /** What makes two targets' tools of one name the same search result. */
  signature: column("signature", Schema.String, { type: "varchar(64)" }),
  /** The listed tool, each shared `$defs` entry replaced by its definition's position. */
  tool: column("tool", Schema.Json),
  /** The positions of the definitions the tool's schemas name. */
  definitions: column("definitions", Schema.Json),
});
const toolSearchDefinitions = table("executor_tool_search_definitions", {
  /** The listing and the definition's position in it. */
  id: idColumn("id", Schema.String, { type: "varchar(80)" }),
  listing: column("listing", Schema.String, { type: "varchar(64)" }),
  position: column("position", Schema.Int),
  definition: column("definition", Schema.Json),
});

/** Tables of the 4.0.9 layout. */
export const version409Tables = {
  ...version408Tables,
  toolSearchListings,
  toolSearch,
  toolSearchDefinitions,
};

/**
 * Indexes added with tool search in 4.0.9, created in the same step as their tables. Terms are
 * text because FumaDB columns are portable; the GIN index is over their words.
 */
export const toolSearchIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listing ON executor_tool_search (listing)",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_terms ON executor_tool_search USING gin ((string_to_array(terms, ' ')))",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listings_target ON executor_tool_search_listings (app, profile)",
  "CREATE INDEX IF NOT EXISTS executor_tool_search_definitions_listing ON executor_tool_search_definitions (listing)",
] as const;

/** The 4.0.9 layout. Profiles own account selections; apps declare requirements. */
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

/**
 * Version 4.0.10 stores OAuth clients as resources of an owner, named by the connections that use
 * them. A registered client is found again by its owner and `automatic_key`, a digest of the
 * sign-in settings, callback included, it was registered for. A client entered by a person has
 * none, unless it was moved from an earlier version's saved clients, whose keys were the same
 * digest. The secret, and a registered client's full registration, are encrypted under the
 * client's ID.
 */
/** Why a stored client no longer holds its credentials; see `executor_stored_oauth_client_credentials`. */
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
  /** A sign-in has completed with this client, so a later rejection means it was revoked. */
  confirmed: column("confirmed", Schema.Boolean).default(false),
  encrypted: column("encrypted", Schema.Uint8Array),
  createdAt: column("created_at", Schema.Date),
});

/**
 * Every set of credentials a stored client holds or held, so credentials are one client wherever
 * they are read from: a grant's copy, an entry in a connect form, or an attempt. The ID is a keyed
 * digest (`Credentials.fingerprint`) of owner, provider, client ID and secret, so it is unique per
 * owner and provider and two clients can never hold the same credentials. Editing a client's
 * details adds a row and keeps the old one, so credentials it held before still resolve to it.
 * Removing a client keeps its rows: credentials of a removed client are withdrawn, never unowned.
 * Removing the owner removes them.
 *
 * `withdrawal` says why the client holding them is gone, and is null while one holds them. A
 * sign-in pending with a client that is gone fails closed without an exchange. When the service
 * itself refused that client (`rejected`) it reports that refusal, `registered_client_rejected`;
 * a person removing it (`removed`), Executor discarding an expired registration (`expired`), or a
 * row naming no reason, report `client_unavailable`.
 */
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

/** Tables of the 4.0.10 layout. */
export const version4010Tables = {
  ...version409Tables,
  storedOAuthClients,
  storedOAuthClientCredentials,
};

/** Indexes added with stored OAuth clients in 4.0.10, created in the same step as their tables. */
export const storedOAuthClientIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_provider ON executor_stored_oauth_clients (owner, provider)",
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_key ON executor_stored_oauth_clients (owner, automatic_key)",
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_client_credentials_owner ON executor_stored_oauth_client_credentials (owner)",
] as const;

/** The 4.0.10 layout: stored OAuth clients keyed by owner and provider. */
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

/**
 * Indexes added in 4.0.11 for reads scoped to one owner or one app code, which scanned the whole
 * table before. In the order the account removal path writes these tables: accounts, then
 * profiles; deployments last.
 */
export const boundedReadIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_accounts_owner_id ON executor_accounts (owner, id)",
  "CREATE INDEX IF NOT EXISTS executor_installations_owner_app ON executor_installations (owner, app)",
  "CREATE INDEX IF NOT EXISTS executor_deployments_code_created ON executor_deployments (code, created_at)",
] as const;

/**
 * Version 4.0.12 keys stored OAuth clients by owner and authorization server instead of owner and
 * provider, so one client serves every app that signs in at the same server. `issuer` is the
 * server's issuer as the sign-in discovered or declared it, or the token endpoint URL when the
 * provider declares endpoints without an issuer (`oauthClientIssuer`). It is null on a client
 * stored before 4.0.12 until data step `8_oauth_clients_by_issuer` records it; such a client is
 * offered to no sign-in, and its credentials resolve to it through their pre-4.0.12 identity.
 * `provider` is kept, now nullable, for those clients and for the running server during the
 * rollout; clients stored from 4.0.12 have none. A later release drops it.
 */
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

/**
 * From 4.0.12 a credentials row's ID digests owner, issuer, client ID and secret, so credentials
 * are one client per owner and authorization server. Rows written before keep their provider
 * digest and their provider; rows written from 4.0.12 have no provider.
 */
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

/** Tables of the 4.0.12 layout. */
export const version4012Tables = {
  ...version409Tables,
  storedOAuthClients: storedOAuthClientsByIssuer,
  storedOAuthClientCredentials: storedOAuthClientCredentialsByIssuer,
};

/** The index 4.0.12 adds, created in the same step as its column. */
export const storedOAuthClientIssuerIndexes = [
  "CREATE INDEX IF NOT EXISTS executor_stored_oauth_clients_owner_issuer ON executor_stored_oauth_clients (owner, issuer)",
] as const;

/** The 4.0.12 layout: stored OAuth clients keyed by owner and authorization server. */
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

/**
 * Version 4.0.13 replaces profiles. Background rows record the actor whose access each run checks;
 * webhook sources record the accounts linked to an app for managed webhooks. A schedule already
 * had an actor: each member has one copy of a declaration and runs it with their linked accounts.
 * Profile columns and `executor_installations` stay, unread by the SDK, until the product has
 * converted them and a later version drops them.
 */
const actorWorkflowRuns = table("executor_workflow_runs", {
  ...version4Tables.workflowRuns.columns,
  /** The subject the run started for; null when the starting operation had no actor. */
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
});
const actorWebhooks = table("executor_webhooks", {
  ...version4Tables.webhooks.columns,
  /** The subject whose access each callback checks. Always set; nullable only for the upgrade. */
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
  /**
   * The actor the provider registration ran as, saved with its accounts before it reaches the
   * provider. Removing the registration runs as this actor, also after the subscription moves to
   * another. Null until registering.
   */
  registeredActor: column("registered_actor", Schema.NullOr(Schema.String), {
    type: "varchar(255)",
  }).default(null),
  /**
   * Every account the provider registration ran with, saved before it reaches the provider.
   * Removing the registration uses them, not the actor's current links. Null until registering.
   */
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
  reconciledDeployment: column("reconciled_deployment", Schema.NullOr(DeploymentId), {
    type: "varchar(255)",
  }),
  lease: column("lease", Schema.NullOr(Schema.String), { type: "varchar(255)" }),
  leaseUntil: column("lease_until", Schema.Date),
  createdAt: column("created_at", Schema.Date),
}).unique("executor_webhook_sources_app_account", ["app", "account"]);

/**
 * The app copies 4.0.13 planned: a member whose profiles of one app used different accounts for a
 * plain requirement keeps the app for one account set and gets a copy for each other. `id` is the
 * copy's reserved app ID; the profile's schedules wait under it, paused, until data step
 * `10_profile_app_copies` creates the copy, links the profiles' accounts and resumes `enable`.
 */
const profileAppCopies = table("executor_profile_app_copies", {
  id: idColumn("id", AppId, { type: "varchar(255)" }),
  /** The app the copy is made from. */
  app: column("app", AppId, { type: "varchar(255)" }),
  owner: column("owner", OwnerId, { type: "varchar(255)" }),
  /** The member whose profiles the copy replaces; only they get its accounts. */
  subject: column("subject", Schema.String, { type: "varchar(255)" }),
  /** The profile the copy is named after, in the app's name: "App (Profile)". */
  label: column("label", Schema.String, { type: "varchar(128)" }),
  /** The member's profiles with this account set, oldest first. */
  profiles: column("profiles", Schema.Json),
  /** The accounts the copy links for the member, from its enabled profiles, oldest first. */
  accounts: column("accounts", Schema.Json),
  /** The webhook configuration of the copy's sources, from its named profile. */
  webhookConfig: column("webhook_config", Schema.Json),
  /**
   * Schedule IDs, parked under `id`, that the copy resumes once it exists. The data step drops each
   * once it is resumed or its resume is refused, so a later pass resumes only the rest.
   */
  enable: column("enable", Schema.Json),
  /** `pending`, then `copied`, or `cancelled` when the app was removed before the copy. */
  status: column("status", Schema.String, { type: "varchar(32)" }),
  createdAt: column("created_at", Schema.Date),
});

/**
 * Tool search listings are kept per app and account set: `target` is a digest of the accounts the
 * listing was evaluated with (see `toolSearchTarget`). Listings written before 4.0.13, or by the
 * previous server during its deploy, name a profile instead and have no target; the SDK neither
 * searches nor supersedes them as a target's own, and removes them as superseded.
 */
const targetedToolSearchListings = table("executor_tool_search_listings", {
  ...toolSearchListings.columns,
  target: column("target", Schema.NullOr(Schema.String), { type: "varchar(64)" }).default(null),
});

/** Tables of the 4.0.13 layout. */
export const version4013Tables = {
  ...version4012Tables,
  workflowRuns: actorWorkflowRuns,
  webhooks: actorWebhooks,
  webhookSources,
  toolSearchListings: targetedToolSearchListings,
  profileAppCopies,
};

/** The index tool search finds a target's listings by from 4.0.13, created in that step. */
export const toolSearchTargetIndex =
  "CREATE INDEX IF NOT EXISTS executor_tool_search_listings_accounts ON executor_tool_search_listings (app, target)";

/**
 * Version 4.0.14 adds app accounts. App schedules and app-account webhook sources run without a
 * caller, so they have no actor: `executor_schedules.actor` and `executor_webhook_sources.actor`
 * become nullable. A declaration has one app schedule, kept unique by `appScheduleIndex`.
 * `executor_workflow_runs.scope` records whether a run started with a caller.
 */
const appScopeSchedules = table("executor_schedules", {
  ...version4013Tables.schedules.columns,
  /** The member whose copy this is; null for an app schedule, which runs without a caller. */
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
});
const appScopeWebhookSources = table("executor_webhook_sources", {
  ...webhookSources.columns,
  /** The subject who linked the account; null for an app link. */
  actor: column("actor", Schema.NullOr(Schema.String), { type: "varchar(255)" }).default(null),
}).unique("executor_webhook_sources_app_account", ["app", "account"]);

/**
 * A workflow run records the scope it started in, so its steps bind `ctx.user` only when it
 * started with a caller. Runs saved before 4.0.14 started with one.
 */
const scopedWorkflowRuns = table("executor_workflow_runs", {
  ...actorWorkflowRuns.columns,
  scope: column("scope", AccountScope, { type: "varchar(16)" }).default("user"),
});

/** Tables of the 4.0.14 layout, the current one. */
export const version4014Tables = {
  ...version4013Tables,
  schedules: appScopeSchedules,
  webhookSources: appScopeWebhookSources,
  workflowRuns: scopedWorkflowRuns,
};

/**
 * Start keys are unique per app, actor and scope from 4.0.14, so a run started without a caller
 * and one started with a caller never share a key. It replaces `executor_workflow_runs_context_key`.
 */
export const scopedRunKeyIndex =
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_scope_key ON executor_workflow_runs (app, COALESCE(actor, ''), COALESCE(installation, ''), scope, start_key)";

/** One app schedule per declaration; members' copies stay unique by `executor_schedules_copy`. */
export const appScheduleIndex =
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_app ON executor_schedules (app, name) WHERE actor IS NULL";
