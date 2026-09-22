import { WorkflowRunId } from "../contracts/workflows.ts";
import { AppSlug } from "../contracts/app-slug.ts";
/** FumaDB schema and client factory. Importing this module performs no I/O. */
import { fumadb } from "fumadb-effect";
import { Effect, Schema } from "effect";
import { SourceCommit } from "../contracts/source.ts";
import { SqlClient } from "effect/unstable/sql";
import { sqlAdapter } from "fumadb-effect/sql";
import type { Provider as SqlProvider } from "fumadb-effect";
import { makeReactiveStore } from "@executor-js/reactivity";
import { bindOrm } from "./reactive-orm.ts";
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
} from "../contracts/shared.ts";
import { StorageError } from "../contracts/shared.ts";
import { AccountConnectionId, ApprovalRequestId } from "../contracts/shared.ts";
import { column, idColumn, schema, table } from "fumadb-effect/schema";

/** Current storage layout. Deployments contain Git and build references, never source files. */
export const storageSchema = schema({
  version: "1.12.0",
  up: ({ auto }) =>
    auto.pipe(
      Effect.map((operations) => [
        ...operations,
        {
          type: "custom" as const,
          sql: "CREATE INDEX executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
        },
        {
          type: "custom" as const,
          sql: "CREATE INDEX executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
        },
        {
          type: "custom" as const,
          sql: "CREATE INDEX executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
        },
      ]),
    ),
  tables: {
    workflowRuns: table("executor_workflow_runs", {
      id: idColumn("id", WorkflowRunId, { type: "varchar(255)" }),
      app: column("app", AppId, { type: "varchar(255)" }),
      owner: column("owner", OwnerId, { type: "varchar(255)" }),
      key: column("start_key", Schema.String, { type: "varchar(128)" }),
      deployment: column("deployment", DeploymentId, { type: "varchar(255)" }),
      name: column("name", Schema.String),
      accounts: column("accounts", Schema.Json),
      status: column("status", Schema.String),
      failure: column("failure", Schema.NullOr(Schema.String)),
      encrypted: column("encrypted", Schema.Uint8Array),
      createdAt: column("created_at", Schema.Date),
    }).unique("executor_workflow_runs_app_key", ["app", "key"]),
    workflowAccounts: table("executor_workflow_accounts", {
      id: idColumn("id", Schema.String, { type: "varchar(255)" }),
      account: column("account", AccountId, { type: "varchar(255)" }),
      run: column("run", WorkflowRunId, { type: "varchar(255)" }),
    }).unique("executor_workflow_accounts_account_run", ["account", "run"]),
    schedules: table("executor_schedules", {
      id: idColumn("id", Schema.String, { type: "varchar(255)" }),
      app: column("app", AppId, { type: "varchar(255)" }),
      owner: column("owner", OwnerId, { type: "varchar(255)" }),
      name: column("name", Schema.String, { type: "varchar(255)" }),
      actor: column("actor", Schema.String, { type: "varchar(255)" }),
      timing: column("timing", Schema.Json),
      enabled: column("enabled", Schema.Boolean),
      approvalMode: column("approval_mode", Schema.String, { type: "varchar(32)" }),
      nextAt: column("next_at", Schema.NullOr(Schema.Date)),
      activeRun: column("active_run", Schema.NullOr(Schema.String), { type: "varchar(255)" }),
      revision: column("revision", Schema.String, { type: "varchar(255)" }),
    }).unique("executor_schedules_app_name", ["app", "name"]),
    scheduledRuns: table("executor_scheduled_runs", {
      id: idColumn("id", Schema.String, { type: "varchar(255)" }),
      scheduleId: column("schedule_id", Schema.String, { type: "varchar(255)" }),
      app: column("app", AppId, { type: "varchar(255)" }),
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
      accounts: column("accounts", Schema.Json),
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
    }).unique("executor_webhooks_app_key", ["app", "key"]),
  },
  relations: {
    accounts: ({ one }) => ({
      providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
    }),
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

/** One current schema for fresh databases; historical layouts are not supported. */
export const executorDatabase = fumadb({ namespace: "executor", schemas: [storageSchema] });

/** Capture caller-owned SQL and initialize the current schema when the host starts. */
export const makeExecutorStorage = (options: { readonly provider: SqlProvider }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* makeReactiveStore({ namespace: "executor" });
    const client = executorDatabase.client(sqlAdapter({ provider: options.provider }));
    const db = bindOrm(client.orm("1.12.0"), sql, reactivity);
    const migrate = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      yield* (yield* migrator.migrateToLatest()).execute;
    }).pipe(
      sql.withTransaction,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    return { orm: (_version: "1.12.0") => db, reactivity, migrate };
  });
/** Caller-owned, Effect-native persistence with commit-driven subscriptions. */
export type ExecutorDatabase = Effect.Success<ReturnType<typeof makeExecutorStorage>>;
