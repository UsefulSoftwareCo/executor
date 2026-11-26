import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { makeExecutorStorage, StorageMigrationFailed } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";
import { migrateProvisioning, migrateContributedDepartures } from "./provisioning-schema.ts";
import { migrateGroups } from "./group-schema.ts";
import { migrateResourceAccess, removeGroupAccountConnections } from "./resource-schema.ts";
import { migrateOAuthClientAccess } from "./oauth-client-schema.ts";
import { migrateOrganizationRemovals } from "./organization-removal-schema.ts";
import { migrateApiKeyMemberships } from "./api-key-membership-schema.ts";
import { queueExecutorAppUpgrades } from "./executor-app-upgrades.ts";
import { migrateAppAccountLinks } from "./app-account-schema.ts";
import { migrateToolCallLog } from "./tool-call-log.ts";
import { migratePersonalAccounts } from "./personal-account-schema.ts";

export class HostedMigrationFailed extends Schema.TaggedError<HostedMigrationFailed>()(
  "HostedMigrationFailed",
  {
    stage: Schema.Literals(["auth", "product"]),
    causeTags: Schema.optionalKey(Schema.Array(Schema.String)),
    sqlState: Schema.optionalKey(Schema.String),
    migrationVersion: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    const tags = this.causeTags?.join(" > ") ?? "unknown cause";
    return `${this.stage} migration failed${this.migrationVersion ? ` at executor version ${this.migrationVersion}` : ""}: ${tags}${this.sqlState ? ` (SQLSTATE ${this.sqlState})` : ""}`;
  }
}

export const migrationFailed =
  (stage: HostedMigrationFailed["stage"]) =>
  (cause: unknown): HostedMigrationFailed => {
    if (cause instanceof StorageMigrationFailed)
      return new HostedMigrationFailed({
        stage,
        causeTags: ["StorageMigrationFailed", ...cause.causeTags],
        ...(cause.sqlState === undefined ? {} : { sqlState: cause.sqlState }),
        ...(cause.migrationVersion === undefined
          ? {}
          : { migrationVersion: cause.migrationVersion }),
      });
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

export const migrateProductSteps = (
  table: "private_hosted_migrations" | "private_cloud_migrations",
  steps: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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
  "4_data_steps": createDataStepJournal("private_hosted"),
  "5_upgrade_executor_apps": queueExecutorAppUpgrades,
  "6_upgrade_pinned_executor_apps": queueExecutorAppUpgrades,
  "7_require_connection_targets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`alter table hosted_connection_access alter column target set not null`;
  }),
  "8_oauth_client_access": migrateOAuthClientAccess,
  "9_app_account_links": migrateAppAccountLinks,
  "10_group_account_connections": removeGroupAccountConnections,
  "11_tool_call_log": migrateToolCallLog,
  "12_personal_accounts": migratePersonalAccounts,
  "13_contributed_departures": migrateContributedDepartures,
});

export const migrateHostedDatabase = (
  options: BetterAuthOptions,
  additional: Effect.Effect<void, HostedMigrationFailed, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`set local lock_timeout = '5s'`;
        yield* sql`set local statement_timeout = '60s'`;
        yield* sql`select pg_advisory_xact_lock(641028113)`;
        yield* migrateHostedSchemas(options, additional);
      }),
    );
  });

export const migrateHostedSchemas = (
  options: BetterAuthOptions,
  additional: Effect.Effect<void, HostedMigrationFailed, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.checkMigration.pipe(Effect.mapError(migrationFailed("product")));
    const migrations = yield* Effect.tryPromise({
      try: () => getMigrations(options),
      catch: migrationFailed("auth"),
    });
    if (migrations.schemaProblems.length > 0)
      return yield* new HostedMigrationFailed({ stage: "auth" });
    yield* Effect.tryPromise({
      try: () => migrations.runMigrations(),
      catch: migrationFailed("auth"),
    });
    yield* storage.migrateTables.pipe(Effect.mapError(migrationFailed("product")));
    yield* hostedProductMigrations;
    yield* additional;
    yield* storage.migrate.pipe(Effect.mapError(migrationFailed("product")));
  });
