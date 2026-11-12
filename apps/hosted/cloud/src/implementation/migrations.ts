import { makeRegistryStorage } from "@executor-js/app-registry";
import { organizationPublishers } from "./publishers.ts";
/** The same explicit Postgres migration operation is used locally and in deployment jobs. */
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

/** Additive cloud tables; existing organizations and memberships are never changed. */
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
      // Auth settings and enrichment use different adapters. Record explicit edits at
      // their shared storage boundary, including clearing a logo or changing a name back.
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

/**
 * Queue future account creations in the same transaction as Better Auth's user insert.
 * No backfill: existing users receive no welcome. Verification is checked at delivery.
 * The queue owns only a user reference and delivery status, not a second profile copy.
 */
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

/**
 * The seat count last confirmed in Autumn, so membership jobs skip unchanged
 * counts. Additive: the running server never reads it. No backfill; the first
 * daily reconcile confirms every organization that has no row.
 */
export const migrateBillingSeats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_billing_seats (
    organization_id text primary key references organization(id) on delete cascade,
    synced_count integer check (synced_count >= 0),
    seat_plan boolean not null default false,
    checked_at timestamptz
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

/**
 * Organization removals whose Workflow start succeeded, so the removal job reads only starts never
 * recorded instead of every running tombstone. Additive: the running server never reads it, and a
 * tombstone without a row is started again under its stored instance, which adopts the existing
 * run. No foreign key, so creating it takes no lock on the tombstones every request reads.
 */
export const migrateOrganizationRemovalStarts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists cloud_organization_removal_start (
    organization_id text primary key,
    instance_id text not null,
    started_at timestamptz not null default now()
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

/**
 * The v1 import map (`notes/v1-import.md`): one row per v1 item an import attempted, with the v2
 * resource it created, why it failed, or why it had nothing to import (`skipped`). `(v1_kind, v1_id)` is unique, so no v1 item is created
 * twice in v2. Additive: the running server never reads it.
 */
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

/**
 * Each v1 organization's import state (`notes/v1-import.md`): the durable record v1's freeze,
 * redirect and forwarding will read, which outlives a Workflow instance's retention. Only an import
 * that writes v2 writes it; a dry run writes only its report. Additive: the running server never
 * reads it.
 */
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

/**
 * The v1 session handoff tokens v2 has accepted (`v1-session-handoff.ts`), so each is used once.
 * A row is needed only until its token expires; the handoff deletes expired rows. Additive: the
 * running server never reads it.
 */
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

/**
 * The v1 organizations an import may write (`notes/v1-import.md`, `v1-import/writes.ts`): an import
 * of an organization without a row is refused. A guard apart from the operator token, which alone
 * allows nothing. No route, operator command or app path writes it; rows are added only by direct
 * SQL from someone with access to the database. It starts empty and copies nothing, so until rows
 * are inserted every import is refused. Additive: the running server never reads it.
 */
export const migrateV1ImportAllowed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_import_allowed (
    v1_org_id text primary key,
    added_at timestamptz not null default now(),
    note text
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));

/**
 * The billing of each paid v1 organization an import moves (`notes/v1-import.md`, "Billing"): its
 * v2 organization, what v1's subscription was and its Stripe subscription, and how far the
 * carry-over got. `held` keeps v2 billing from creating the organization's customer while v1's is
 * carried over, `carried` lets it bill normally, and `returned` means v1 bills the organization
 * again. The import inserts the row with the organization. Additive: the running server never
 * reads it.
 */
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

/**
 * The v2 organization an import of the row's v1 organization may rename to take its slug
 * (`notes/v1-import.md`, "Slug displacement"), written by direct SQL like the rest of the table.
 * Additive and nullable, without a default, so adding it rewrites nothing; the running server
 * reads only `v1_org_id`.
 */
export const migrateV1ImportDisplacement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table private_v1_import_allowed add column if not exists displace_v2_org_id text`;
}).pipe(Effect.mapError(migrationFailed("product")));

/**
 * The existing v2 organization the row's v1 organization moves into instead of a new one, and how
 * (`notes/v1-import.md`, decision 32), written by direct SQL like the rest of the table. Additive
 * and nullable, without defaults, so adding them rewrites nothing; the running server reads only
 * `v1_org_id` and `displace_v2_org_id`.
 */
export const migrateV1ImportInto = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table private_v1_import_allowed add column if not exists into_v2_org_id text`;
  yield* sql`alter table private_v1_import_allowed add column if not exists into_mode text`;
}).pipe(Effect.mapError(migrationFailed("product")));

/**
 * The onboarding experiment's assignments (`notes/posthog.md#onboarding-order-experiment`): one
 * row per member who created their first team through team setup and was assigned a variant,
 * and when they first saw it. Additive: the running server never reads it. Drop it in a later
 * release once the experiment is retired.
 */
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

/**
 * The onboarding skip experiment's assignments (`notes/posthog.md#onboarding-skip-experiment`): one
 * row per member who created their first team through team setup and was assigned a variant, when
 * they first saw it, and when a `required` member finished both setup steps. Kept apart from
 * `cloud_setup_assignment` because each flag can be unavailable on its own. Additive: the running
 * server never reads it. Drop it in a later release once the experiment is retired.
 */
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

/** Apply Better Auth and product migrations, then close both database pools. */
export const migrateCloudDatabase = Effect.scoped(
  Effect.gen(function* () {
    const setup = yield* cloudAuthSetup;
    // The pinned driver does not include regclass (OID 2205), which Effect's
    // migrator uses to find its journal. Its binary representation is an OID.
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
      });
    });
    yield* migrateHostedDatabase(setup.options, cloudMigrations).pipe(
      Effect.provide(PgClient.layer({ url: setup.url, maxConnections: 1, types })),
    );
    yield* setup.provision;
    yield* Effect.log("Hosted Postgres schemas are current");
  }),
);
