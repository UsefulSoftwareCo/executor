/** Current storage and the guarded upgrade from the deployed version 3 layout. */
import { fumadb } from "fumadb-effect";
import type { MigrationOperation } from "fumadb-effect/migration";
import { schema, table } from "fumadb-effect/schema";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { sqlAdapter } from "fumadb-effect/sql";
import type { Provider as SqlProvider } from "fumadb-effect";
import { makeReactiveStore } from "@executor-js/reactivity";
import { StorageError } from "../contracts/shared.ts";
import { bindOrm } from "./reactive-orm.ts";
import { storageSchemaV3 } from "./storage-schema-v3.ts";

// These checks and the column removal execute in the migrator's single transaction.
// PostgreSQL and PGlite are the storage engines used by the hosted and local products.
const upgrade: readonly MigrationOperation[] = [
  {
    type: "custom",
    sql: "LOCK TABLE executor_apps, executor_deployments, executor_workflow_runs, executor_webhooks, executor_schedules, executor_scheduled_runs, executor_account_connections IN ACCESS EXCLUSIVE MODE",
  },
  {
    type: "custom",
    sql: `DO $upgrade$
BEGIN
  IF EXISTS (SELECT 1 FROM executor_apps WHERE accounts::jsonb IS DISTINCT FROM '{}'::jsonb) THEN
    RAISE EXCEPTION 'Executor upgrade blocked: move app account selections into explicit profiles before upgrading';
  END IF;
  IF EXISTS (
    SELECT 1 FROM executor_workflow_runs WHERE installation IS NULL
      AND status NOT IN ('complete', 'errored', 'terminated') AND accounts::jsonb <> '{}'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM executor_webhooks WHERE installation IS NULL AND accounts::jsonb <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Executor upgrade blocked: finish account-dependent workflows and remove webhooks without profiles before upgrading';
  END IF;
  IF EXISTS (
    SELECT 1 FROM executor_schedules s
      JOIN executor_apps a ON a.id = s.app
      JOIN executor_deployments d ON d.id = a.active_deployment
    WHERE s.installation IS NULL AND d.requirements::jsonb -> 'accounts' <> '{}'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM executor_scheduled_runs r
      JOIN executor_apps a ON a.id = r.app
      JOIN executor_deployments d ON d.id = a.active_deployment
    WHERE r.installation IS NULL AND r.status IN ('running', 'awaiting-approval', 'ready')
      AND d.requirements::jsonb -> 'accounts' <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Executor upgrade blocked: recreate account-dependent schedules without profiles and finish their pending runs before upgrading';
  END IF;
  IF EXISTS (
    SELECT 1 FROM executor_account_connections
    WHERE target IS NOT NULL AND target::jsonb ->> 'installation' IS NULL
  ) THEN
    RAISE EXCEPTION 'Executor upgrade blocked: resolve stored account connection targets without profiles before upgrading';
  END IF;
END
$upgrade$`,
  },
  {
    type: "update-table",
    name: "executor_apps",
    value: [{ type: "drop-column", name: "accounts" }],
  },
];

const { accounts: _legacyAccounts, ...appColumns } = storageSchemaV3.tables.apps.columns;
/** Profiles alone store selections. Version 3 is retained only as an upgrade source. */
export const storageSchema = schema({
  version: "4.0.0",
  up: () => Effect.succeed(upgrade),
  tables: {
    ...storageSchemaV3.tables,
    apps: table("executor_apps", appColumns)
      .unique("executor_apps_owner_name", ["owner", "name"])
      .unique("executor_apps_owner_slug", ["owner", "slug"]),
  },
  relations: {
    apps: ({ one }) => ({
      deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
    }),
  },
});

/** Fresh initialization and the guarded version 3 to 4 upgrade share the same migrator. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: [storageSchemaV3, storageSchema],
});

/** Capture caller-owned SQL and initialize the current schema when the host starts. */
export const makeExecutorStorage = (options: { readonly provider: SqlProvider }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* makeReactiveStore({ namespace: "executor" });
    const client = executorDatabase.client(sqlAdapter({ provider: options.provider }));
    const db = bindOrm(client.orm("4.0.0"), sql, reactivity);
    const migrate = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      yield* (yield* migrator.migrateToLatest()).execute;
    }).pipe(
      sql.withTransaction,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    return { orm: (_version: "4.0.0") => db, reactivity, migrate };
  });
/** Caller-owned, Effect-native persistence with commit-driven subscriptions. */
export type ExecutorDatabase = Effect.Success<ReturnType<typeof makeExecutorStorage>>;
