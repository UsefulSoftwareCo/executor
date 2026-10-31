/** Schema ownership is separate even though auth and product share one Postgres database. */
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { makeExecutorStorage } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";
import { migrateProvisioning, migrateContributedDepartures } from "./provisioning-schema.ts";
import { migrateGroups } from "./group-schema.ts";
import { migrateResourceAccess } from "./resource-schema.ts";
import { migrateOAuthClientAccess } from "./oauth-client-schema.ts";
import { migrateOrganizationRemovals } from "./organization-removal-schema.ts";
import { migrateApiKeyMemberships } from "./api-key-membership-schema.ts";
import { queueExecutorAppUpgrades } from "./executor-app-upgrades.ts";
import { migrateAppAccountLinks } from "./app-account-schema.ts";

/**
 * Migration failures stop startup; callers must not log the driver's secret-bearing cause. The
 * error keeps only what is safe to log from it: the tags along its cause chain and the first
 * Postgres SQLSTATE.
 */
export class HostedMigrationFailed extends Schema.TaggedError<HostedMigrationFailed>()(
  "HostedMigrationFailed",
  {
    stage: Schema.Literals(["auth", "product"]),
    causeTags: Schema.optionalKey(Schema.Array(Schema.String)),
    sqlState: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    const tags = this.causeTags?.join(" > ") ?? "unknown cause";
    return `${this.stage} migration failed: ${tags}${this.sqlState ? ` (SQLSTATE ${this.sqlState})` : ""}`;
  }
}

/** A {@link HostedMigrationFailed} carrying only the safe parts of `cause`. */
export const migrationFailed =
  (stage: HostedMigrationFailed["stage"]) =>
  (cause: unknown): HostedMigrationFailed => {
    const causeTags: Array<string> = [];
    let sqlState: string | undefined;
    let current: unknown = cause;
    for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
      const tag = Reflect.get(current, "_tag") ?? Reflect.get(current, "name");
      if (typeof tag === "string") causeTags.push(tag);
      const code = Reflect.get(current, "code");
      if (sqlState === undefined && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
        sqlState = code;
      current = Reflect.get(current, "cause");
    }
    return new HostedMigrationFailed({
      stage,
      ...(causeTags.length > 0 ? { causeTags } : {}),
      ...(sqlState === undefined ? {} : { sqlState }),
    });
  };

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
        ? Effect.fail(migrationFailed("product")(error))
        : Effect.die(error),
    ),
    Effect.mapError(migrationFailed("product")),
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
  // Step 5 skipped apps whose only change since deploying was the framework pin commit.
  "6_upgrade_pinned_executor_apps": queueExecutorAppUpgrades,
  // SDK 4.0.8 deleted every connection without a target, and these rows with them. The running
  // server records a target for every connection it creates.
  "7_require_connection_targets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`alter table hosted_connection_access alter column target set not null`;
  }),
  // Additive: who may use each stored OAuth client; the running server never reads it.
  "8_oauth_client_access": migrateOAuthClientAccess,
  // App and user account links; profiles become user links. Runs after SDK 4.0.13, which keeps
  // the profiles.
  "9_app_account_links": migrateAppAccountLinks,
  "10_contributed_departures": migrateContributedDepartures,
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
        yield* migrateHostedSchemas(options, additional);
      }),
    );
  });

/**
 * Run both migrators, then the caller's additional product steps; the caller holds exclusive
 * startup/job access.
 */
export const migrateHostedSchemas = (
  options: BetterAuthOptions,
  additional: Effect.Effect<void, HostedMigrationFailed, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    // Check compatibility before Better Auth's independent pool can commit DDL.
    yield* storage.checkMigration.pipe(Effect.mapError(migrationFailed("product")));
    const migrations = yield* Effect.tryPromise({
      try: () => getMigrations(options),
      catch: migrationFailed("auth"),
    });
    // Better Auth cannot repair unexpected required columns. Check that verdict
    // before applying migrations rather than discovering it on the next login.
    if (migrations.schemaProblems.length > 0)
      return yield* new HostedMigrationFailed({ stage: "auth" });
    yield* Effect.tryPromise({
      try: () => migrations.runMigrations(),
      catch: migrationFailed("auth"),
    });
    yield* storage.migrateTables.pipe(Effect.mapError(migrationFailed("product")));
    yield* hostedProductMigrations;
    yield* additional;
    // Index builds block writes to their tables until the enclosing transaction commits, and
    // runtime writers set no lock timeout. Build them last so they hold that lock only for
    // themselves, the version update and the commit.
    yield* storage.migrate.pipe(Effect.mapError(migrationFailed("product")));
  });
