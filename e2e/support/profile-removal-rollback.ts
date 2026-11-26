export const beforeProfileRemoval = (
  options: { readonly toolSearch: boolean } = { toolSearch: true },
): ReadonlyArray<{ readonly sql: string }> => [
  { sql: `DROP TRIGGER IF EXISTS executor_workflow_runs_profile_actor ON executor_workflow_runs` },
  { sql: `DROP TRIGGER IF EXISTS executor_webhooks_profile_actor ON executor_webhooks` },
  { sql: `DROP TRIGGER IF EXISTS executor_schedules_profile_actor ON executor_schedules` },
  {
    sql: `DROP FUNCTION IF EXISTS executor_profile_actor(), executor_profile_webhook(),
      executor_profile_schedule()`,
  },
  { sql: `DROP INDEX IF EXISTS executor_schedules_copy` },
  { sql: `DROP TABLE executor_webhook_sources` },
  { sql: `DROP TABLE executor_profile_app_copies` },
  { sql: `ALTER TABLE executor_workflow_runs DROP COLUMN actor` },
  {
    sql: `ALTER TABLE executor_webhooks
      DROP COLUMN actor, DROP COLUMN registered_actor, DROP COLUMN registered_accounts`,
  },
  ...(options.toolSearch
    ? [{ sql: `ALTER TABLE executor_tool_search_listings DROP COLUMN target` }]
    : []),
];

export const profileAppCopiesPending = (
  journal: "private_hosted" | "private_local",
): ReadonlyArray<{ readonly sql: string; readonly params: ReadonlyArray<string> }> => [
  {
    sql: `DELETE FROM ${journal}_data_step_items WHERE name = $1`,
    params: ["10_profile_app_copies"],
  },
  { sql: `DELETE FROM ${journal}_data_steps WHERE name = $1`, params: ["10_profile_app_copies"] },
];

export const beforeAppAccounts = (): ReadonlyArray<{ readonly sql: string }> => [
  { sql: "DROP TABLE executor_account_reports" },
  { sql: "DROP INDEX executor_event_subscriptions_owner_selection" },
  {
    sql: `ALTER TABLE executor_event_subscriptions DROP COLUMN selection,
      ALTER COLUMN app DROP DEFAULT, ALTER COLUMN app SET NOT NULL,
      ALTER COLUMN event DROP DEFAULT, ALTER COLUMN event SET NOT NULL`,
  },
  { sql: "ALTER TABLE executor_webhook_sources DROP COLUMN retries" },
  { sql: "DROP INDEX executor_schedules_app" },
  { sql: "DROP INDEX executor_workflow_runs_scope_key" },
  { sql: "ALTER TABLE executor_workflow_runs DROP COLUMN scope" },
  {
    sql: `CREATE UNIQUE INDEX executor_workflow_runs_context_key ON executor_workflow_runs
      (app, COALESCE(actor, ''), COALESCE(installation, ''), start_key)`,
  },
  {
    sql: "ALTER TABLE executor_schedules ALTER COLUMN actor DROP DEFAULT, ALTER COLUMN actor SET NOT NULL",
  },
  {
    sql: "ALTER TABLE executor_webhook_sources ALTER COLUMN actor DROP DEFAULT, ALTER COLUMN actor SET NOT NULL",
  },
  { sql: `UPDATE private_executor_settings SET value = '4.0.13' WHERE key = 'version'` },
];
