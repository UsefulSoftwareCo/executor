import { makeRegistryStorage } from "@executor-js/app-registry";
import { organizationPublishers } from "./publishers.ts";
import { PgClient, PgTypes } from "@effect/sql-pg";
import {
  migrateHostedDatabase,
  migrationFailed,
  migrateProductSteps,
} from "@executor-js/hosted-server/migrations";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { cloudAuthSetup } from "./auth-provisioning.ts";
import { migrateAppDomainRecords } from "./app-domain-records.ts";
import { migrateV1CapturedApiKeys } from "./v1-captured-api-keys.ts";
import { migrateV1LegacyUrls } from "./v1-legacy-urls.ts";

export const migrateOnboarding = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`create table if not exists cloud_company_profile (
      domain text primary key,
      status text not null default 'pending' check (status in ('pending', 'ready', 'unavailable')),
      profile text check ((status = 'ready') = (profile is not null)),
      attempts integer not null default 0,
      lease text,
      retry_at timestamptz not null default now()
    )`;
      yield* sql`create table if not exists cloud_organization_setup (
      user_id text primary key references "user"(id) on delete cascade,
      organization_id text not null unique references organization(id) on delete cascade,
      domain text references cloud_company_profile(domain),
      name_edited boolean not null default false,
      logo_edited boolean not null default false,
      applied boolean not null default false
    )`;
      yield* sql`create or replace function cloud_mark_organization_edit() returns trigger as $$
      begin
        update cloud_organization_setup set
          name_edited = name_edited or TG_ARGV[0] = 'name',
          logo_edited = logo_edited or TG_ARGV[0] = 'logo'
          where organization_id = NEW.id and not applied;
        return NEW;
      end;
      $$ language plpgsql`;
      yield* sql`drop trigger if exists cloud_organization_name_edit on organization`;
      yield* sql`create trigger cloud_organization_name_edit after update of name on organization
      for each row execute function cloud_mark_organization_edit('name')`;
      yield* sql`drop trigger if exists cloud_organization_logo_edit on organization`;
      yield* sql`create trigger cloud_organization_logo_edit after update of logo on organization
      for each row execute function cloud_mark_organization_edit('logo')`;
    }),
  );
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateWelcomeEmails = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`create table if not exists cloud_email_preferences (
        user_id text primary key references "user"(id) on delete cascade,
        optional_emails_unsubscribed_at timestamptz
      )`;
      yield* sql`create table if not exists cloud_welcome_email (
        user_id text primary key references "user"(id) on delete cascade,
        status text not null default 'pending' check (status in ('pending', 'attempting', 'sent', 'uncertain')),
        created_at timestamptz not null default now(),
        attempted_at timestamptz,
        sent_at timestamptz,
        check ((status = 'pending') = (attempted_at is null)),
        check ((status = 'sent') = (sent_at is not null))
      )`;
      yield* sql`create index if not exists cloud_welcome_email_pending
        on cloud_welcome_email (created_at, user_id) where status = 'pending'`;
      yield* sql`create or replace function cloud_queue_welcome_email() returns trigger as $$
        begin
          insert into cloud_welcome_email (user_id) values (NEW.id) on conflict do nothing;
          return NEW;
        end;
        $$ language plpgsql`;
      yield* sql`drop trigger if exists cloud_welcome_email_created on "user"`;
      yield* sql`create trigger cloud_welcome_email_created after insert on "user"
        for each row execute function cloud_queue_welcome_email()`;
    }),
  );
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateBillingSeats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_billing_seats (
    organization_id text primary key references organization(id) on delete cascade,
    synced_count integer check (synced_count >= 0),
    seat_plan boolean not null default false,
    checked_at timestamptz
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateOrganizationRemovalStarts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_organization_removal_start (
    organization_id text primary key,
    instance_id text not null,
    started_at timestamptz not null default now()
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportMap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_import_map (
    v1_org_id text not null,
    v1_kind text not null,
    v1_id text not null,
    v2_kind text,
    v2_id text,
    status text not null check (status in ('imported', 'failed', 'skipped')),
    reason text,
    source_hash text not null,
    updated_at timestamptz not null default now(),
    unique (v1_kind, v1_id),
    check ((status = 'imported') = (v2_id is not null))
  )`;
  yield* sql`create index if not exists private_v1_import_map_org on private_v1_import_map (v1_org_id)`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportOrgs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_import_org (
    v1_org_id text primary key,
    v2_org_id text,
    state text not null check (state in
      ('planned', 'frozen', 'importing', 'imported', 'cutover', 'failed', 'rolled_back')),
    run_id text not null,
    report jsonb not null,
    updated_at timestamptz not null default now()
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1SessionHandoffs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_session_handoff (
    jti text primary key,
    expires_at timestamptz not null,
    used_at timestamptz not null default now()
  )`;
  yield* sql`create index if not exists private_v1_session_handoff_expires
    on private_v1_session_handoff (expires_at)`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportAllowed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_import_allowed (
    v1_org_id text primary key,
    added_at timestamptz not null default now(),
    note text
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportBilling = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_import_billing (
    organization_id text primary key references organization(id) on delete cascade,
    v1_org_id text not null unique,
    state text not null check (state in ('held', 'carried', 'returned')),
    subscription jsonb not null,
    stripe_subscription_id text,
    updated_at timestamptz not null default now()
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportDisplacement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table private_v1_import_allowed add column if not exists displace_v2_org_id text`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportInto = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table private_v1_import_allowed add column if not exists into_v2_org_id text`;
  yield* sql`alter table private_v1_import_allowed add column if not exists into_mode text`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateV1ImportIntoIntegrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table private_v1_import_allowed add column if not exists into_integrations text[]`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateSetupAssignments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_setup_assignment (
    user_id text primary key,
    organization_id text not null,
    variant text not null check (variant in ('accounts_first', 'assistant_first')),
    assigned_at timestamptz not null default now(),
    exposed_at timestamptz
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateSetupSkipAssignments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_setup_skip_assignment (
    user_id text primary key,
    organization_id text not null,
    variant text not null check (variant in ('skippable', 'required')),
    assigned_at timestamptz not null default now(),
    exposed_at timestamptz,
    completed_at timestamptz
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

export const migrateCloudDatabase = Effect.scoped(
  Effect.gen(function* () {
    const setup = yield* cloudAuthSetup;
    const types = PgTypes.makeRegistry();
    types.register(2205, {
      decode: (bytes) => PgTypes.decode(bytes, PgTypes.OID.oid, 1),
      encode: (value) => PgTypes.encode(value, PgTypes.OID.oid),
    });
    const cloudMigrations = Effect.gen(function* () {
      const registry = yield* makeRegistryStorage(yield* organizationPublishers);
      yield* registry.migrate.pipe(Effect.mapError(migrationFailed("product")));
      yield* migrateProductSteps("private_cloud_migrations", {
        "1_baseline": migrateOnboarding.pipe(Effect.andThen(migrateWelcomeEmails)),
        "2_billing_seats": migrateBillingSeats,
        "3_app_domain_records": migrateAppDomainRecords,
        "4_organization_removal_starts": migrateOrganizationRemovalStarts,
        "5_v1_import_map": migrateV1ImportMap,
        "6_setup_assignments": migrateSetupAssignments,
        "7_v1_import_orgs": migrateV1ImportOrgs,
        "8_v1_session_handoffs": migrateV1SessionHandoffs,
        "9_v1_import_allowed": migrateV1ImportAllowed,
        "10_setup_skip_assignments": migrateSetupSkipAssignments,
        "11_v1_import_billing": migrateV1ImportBilling,
        "12_v1_import_displacement": migrateV1ImportDisplacement,
        "13_v1_import_into": migrateV1ImportInto,
        "14_v1_import_into_integrations": migrateV1ImportIntoIntegrations,
        "15_v1_legacy_urls": migrateV1LegacyUrls,
        "16_v1_captured_api_keys": migrateV1CapturedApiKeys,
      });
    });
    yield* migrateHostedDatabase(setup.options, cloudMigrations).pipe(
      Effect.provide(PgClient.layer({ url: setup.url, maxConnections: 1, types })),
    );
    yield* setup.provision;
    yield* Effect.log("Hosted Postgres schemas are current");
  }),
);
