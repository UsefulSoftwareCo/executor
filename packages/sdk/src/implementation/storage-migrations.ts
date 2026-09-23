/** Current baseline and the additive repair required by existing version 4 databases. */
import { fumadb } from "fumadb-effect";
import { schema } from "fumadb-effect/schema";
import { Effect } from "effect";
import { storageSchema } from "./storage-schema.ts";

/** Indexes that are part of the current storage contract, including fresh databases. */
export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

/** Version 4 is the oldest supported layout. Append future compatible upgrades here. */
export const storageSchemas = [
  storageSchema,
  schema({
    version: "4.0.1",
    tables: storageSchema.tables,
    up: () => Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  }),
] as const;

/** Versioned persistence factory; constructing it does not touch a database. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
