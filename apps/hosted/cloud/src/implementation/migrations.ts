import { makeRegistryStorage } from "@executor-js/app-registry";
/** The same explicit Postgres migration operation is used locally and in deployment jobs. */
import { PgClient, PgTypes } from "@effect/sql-pg";
import {
  HostedMigrationFailed,
  migrateHostedDatabase,
  migrateProductSteps,
} from "@executor-js/hosted-server/migrations";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { cloudAuthSetup } from "./auth-provisioning.ts";

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
}).pipe(Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })));

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
}).pipe(Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })));

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
}).pipe(Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })));

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
      const registry = yield* makeRegistryStorage;
      yield* registry.migrate.pipe(
        Effect.mapError(() => new HostedMigrationFailed({ stage: "product" })),
      );
      yield* migrateProductSteps("private_cloud_migrations", {
        "1_baseline": migrateOnboarding.pipe(Effect.andThen(migrateWelcomeEmails)),
        "2_billing_seats": migrateBillingSeats,
      });
    });
    yield* migrateHostedDatabase(setup.options, cloudMigrations).pipe(
      Effect.provide(PgClient.layer({ url: setup.url, maxConnections: 1, types })),
    );
    yield* setup.provision;
    yield* Effect.log("Hosted Postgres schemas are current");
  }),
);
