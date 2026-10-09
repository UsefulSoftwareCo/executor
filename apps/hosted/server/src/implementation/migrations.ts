/** Schema ownership is separate even though auth and product share one Postgres database. */
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { makeExecutorStorage } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";
import { migrateProvisioning } from "./provisioning-schema.ts";
import { migrateGroups } from "./group-schema.ts";
import { migrateResourceAccess } from "./resource-schema.ts";
import { migrateOrganizationRemovals } from "./organization-removal-schema.ts";
import { migrateApiKeyMemberships } from "./api-key-membership-schema.ts";
import { queueExecutorAppUpgrades } from "./executor-app-upgrades.ts";

/** Migration failures stop startup; callers must not log the driver's secret-bearing cause. */
export class HostedMigrationFailed extends Schema.TaggedError<HostedMigrationFailed>()(
  "HostedMigrationFailed",
  {
    stage: Schema.Literals(["auth", "product"]),
  },
) {}

/**
 * Apply an append-only list once, with completion recorded in the same SQL
 * transaction. The caller owns startup access or the hosted migration lock.
 */
export const migrateProductSteps = (
  table: "private_hosted_migrations" | "private_cloud_migrations",
  steps: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Effect's Postgres migrator probes with ::regclass. Bootstrap explicitly
    // so a missing journal cannot abort the caller's enclosing transaction.
    yield* sql`create table if not exists ${sql(table)} (
      migration_id integer primary key,
      created_at timestamp with time zone not null default now(),
      name text not null
    )`;
    yield* Migrator.make({})({ table, loader: Migrator.fromRecord(steps) });
  }).pipe(
    Effect.catchDefect((error) =>
      error instanceof Migrator.MigrationError
        ? Effect.fail(new HostedMigrationFailed({ stage: "product" }))
        : Effect.die(error),
    ),
    Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })),
  );

const hostedProductMigrations = migrateProductSteps("private_hosted_migrations", {
  "1_baseline": Effect.gen(function* () {
    yield* migrateGroups;
    yield* migrateResourceAccess;
    yield* migrateProvisioning;
    yield* migrateOrganizationRemovals;
  }),
  "2_api_key_memberships": migrateApiKeyMemberships,
  "3_upgrade_executor_apps": queueExecutorAppUpgrades,
  // Additive: the journal for data steps the new server runs; the running server never reads it.
  "4_data_steps": createDataStepJournal("private_hosted"),
  // The template moved to routers and served framework lookups (#829, #841).
  "5_upgrade_executor_apps": queueExecutorAppUpgrades,
  // Step 5 skipped apps whose only change since deployment was the framework pin commit.
  "6_upgrade_pinned_executor_apps": queueExecutorAppUpgrades,
});

/**
 * Explicit, serialized migration job. Better Auth owns its tables; FumaDB owns executor_*.
 * Auth additions commit independently. If product migration fails, rerun the job after repair.
 * This creates/upgrades Postgres schemas, never transfers data from SQLite or D1.
 */
export const migrateHostedDatabase = (
  options: BetterAuthOptions,
  additional: Effect.Effect<void, HostedMigrationFailed, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Fail the deployment instead of waiting indefinitely behind live work.
        yield* sql`set local lock_timeout = '5s'`;
        yield* sql`set local statement_timeout = '60s'`;
        yield* sql`select pg_advisory_xact_lock(641028113)`;
        yield* migrateHostedSchemas(options);
        yield* additional;
      }),
    );
  });

/** Run both migrators; the caller holds exclusive startup/job access. */
export const migrateHostedSchemas = (options: BetterAuthOptions) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    // Check compatibility before Better Auth's independent pool can commit DDL.
    yield* storage.checkMigration.pipe(
      Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })),
    );
    const migrations = yield* Effect.tryPromise({
      try: () => getMigrations(options),
      catch: () => new HostedMigrationFailed({ stage: "auth" }),
    });
    // Better Auth cannot repair unexpected required columns. Check that verdict
    // before applying migrations rather than discovering it on the next login.
    if (migrations.schemaProblems.length > 0)
      return yield* new HostedMigrationFailed({ stage: "auth" });
    yield* Effect.tryPromise({
      try: () => migrations.runMigrations(),
      catch: () => new HostedMigrationFailed({ stage: "auth" }),
    });
    yield* storage.migrate.pipe(
      Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })),
    );
    yield* hostedProductMigrations;
  });
