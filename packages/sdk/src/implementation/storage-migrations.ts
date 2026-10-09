/** Current baseline and the additive repair required by existing version 4 databases. */
import { fumadb } from "fumadb-effect";
import { Effect } from "effect";
import { schema, type CustomMigrationFn } from "fumadb-effect/schema";
import {
  eventIndexes,
  storageSchema,
  version402Tables,
  version403Tables,
  version404Tables,
  version405Tables,
  version406Tables,
  version4Tables,
} from "./storage-schema.ts";

/** Indexes the 4.0.1 step added. Released steps never change; later indexes join their own step. */
export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

/** Every index of the current layout, for a new database. Upgrades add each in its own step. */
export const currentIndexes = [...storageIndexes, ...eventIndexes] as const;

/** A shipped version 4 layout, with the same foreign keys as the current schema. */
const version4 = <Version extends string>(version: Version, up?: CustomMigrationFn) =>
  schema({
    version,
    tables: version4Tables,
    ...(up === undefined ? {} : { up }),
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  });

/** Version 4 is the oldest supported layout. Append future compatible upgrades here. */
export const storageSchemas = [
  version4("4.0.0"),
  version4("4.0.1", () =>
    Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  ),
  // Additive: existing accounts start at generation 0 and the running server ignores the column.
  schema({
    version: "4.0.2",
    tables: version402Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a new account checks table that the running server never reads.
  schema({
    version: "4.0.3",
    tables: version403Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable account description; the running server neither reads nor writes it.
  schema({
    version: "4.0.4",
    tables: version404Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable column the running server never names. Existing accounts read as
  // connected without hosts, which is how they behave before this version.
  schema({
    version: "4.0.5",
    tables: version405Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable check message the running server never names. Existing checks have none.
  schema({
    version: "4.0.6",
    tables: version406Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: three event tables and their indexes, which the running server never names.
  storageSchema,
] as const;

/** Versioned persistence factory; constructing it does not touch a database. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
