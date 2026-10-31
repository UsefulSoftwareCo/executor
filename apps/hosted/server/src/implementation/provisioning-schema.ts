/** Durable lifecycle handoff, committed by the same transaction as auth changes. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Install the current lifecycle queue after auth tables. Never backfill existing users or jobs. */
export const migrateProvisioning = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_provisioning (
    id text primary key default gen_random_uuid()::text,
    kind text not null constraint hosted_provisioning_kind check (kind in ('user', 'team', 'member', 'billing', 'domain')),
    organization_id text references organization(id) on delete cascade,
    user_id text references "user"(id) on delete cascade,
    status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
    attempts integer not null default 0,
    available_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hosted_provisioning_subject check (
      (kind = 'user' and user_id is not null and organization_id is null)
      or (kind = 'member' and user_id is not null and organization_id is not null)
      or (kind in ('team', 'billing', 'domain') and organization_id is not null and user_id is null))
  )`;
  yield* sql`create index if not exists hosted_provisioning_pending on hosted_provisioning (available_at) where status in ('queued', 'running')`;
  yield* sql`create index if not exists hosted_provisioning_member on hosted_provisioning (organization_id, user_id, updated_at desc) where kind = 'member'`;
  yield* sql`create or replace function hosted_queue_team() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'INSERT' then
        insert into hosted_provisioning (id, kind, organization_id) values ('team-' || NEW.id, 'team', NEW.id) on conflict do nothing;
        insert into hosted_provisioning (kind, organization_id) values ('billing', NEW.id);
      end if;
      insert into hosted_provisioning (kind, organization_id) values ('domain', NEW.id);
      return NEW;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_team after insert or update of slug on organization for each row execute function hosted_queue_team()`;
  yield* sql`create or replace function hosted_queue_member() returns trigger language plpgsql as $$
    declare team text;
    begin
      team := case when TG_OP = 'DELETE' then OLD."organizationId" else NEW."organizationId" end;
      -- Cascade deletion must not insert an event referencing a removed team.
      if exists (select 1 from organization where id = team) then
        insert into hosted_provisioning (kind, organization_id) values ('billing', team);
        if TG_OP <> 'DELETE' then
          insert into hosted_provisioning (kind, organization_id, user_id) values ('member', team, NEW."userId");
        end if;
      end if;
      return null;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_member after insert or update of role or delete on member for each row execute function hosted_queue_member()`;
  yield* sql`create or replace function hosted_queue_user() returns trigger language plpgsql as $$
    begin
      if NEW."emailVerified" and (TG_OP = 'INSERT' or not OLD."emailVerified") then
        insert into hosted_provisioning (id, kind, user_id) values ('user-' || NEW.id, 'user', NEW.id) on conflict do nothing;
        insert into hosted_provisioning (kind, organization_id, user_id)
          select 'member', "organizationId", NEW.id from member where "userId" = NEW.id;
      end if;
      return NEW;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_user after insert or update of "emailVerified" on "user" for each row execute function hosted_queue_user()`;
});

/**
 * Additive outbox. Use the existing member job kind so a running old server can still parse its
 * queue. It may acknowledge the job without cleanup; retained snapshots let the new runner recover it.
 */
export const migrateContributedDepartures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Snapshot the links at departure, so a delayed retry cannot remove a later contribution.
  yield* sql`create table if not exists hosted_contributed_departures (
    job text not null references hosted_provisioning(id) on delete cascade,
    app text not null,
    requirement text not null,
    account text not null,
    linked_at timestamptz not null,
    primary key (job, app, requirement, account)
  )`;
  yield* sql`create or replace function hosted_queue_member() returns trigger language plpgsql as $$
    declare team text; departure text;
    begin
      team := case when TG_OP = 'DELETE' then OLD."organizationId" else NEW."organizationId" end;
      -- Cascade deletion must not insert an event referencing a removed team.
      if exists (select 1 from organization where id = team) then
        insert into hosted_provisioning (kind, organization_id) values ('billing', team);
        if TG_OP <> 'DELETE' then
          insert into hosted_provisioning (kind, organization_id, user_id) values ('member', team, NEW."userId");
        elsif exists (select 1 from "user" where id = OLD."userId")
          and to_regclass('hosted_app_account_links') is not null
          and to_regclass('hosted_account_access') is not null
          and to_regclass('executor_deployments') is not null then
          departure := 'contributed-departure-' || gen_random_uuid()::text;
          insert into hosted_provisioning (id, kind, organization_id, user_id)
            values (departure, 'member', team, OLD."userId");
          insert into hosted_contributed_departures (job, app, requirement, account, linked_at)
            select departure, l.app, l.requirement, l.account, l.created_at
            from hosted_app_account_links l
            join hosted_account_access p on p.account_id = l.account
            join executor_apps a on a.id = l.app and a.owner = 'organization:' || team
            join executor_deployments d on d.id = a.active_deployment
            where l.subject is null and l.linked_by = OLD."userId"
              and p.organization_id = team and p.kind = 'personal' and p.personal_user_id = OLD."userId"
              and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'scope' = 'app'
              and d.requirements::jsonb -> 'accounts' -> l.requirement ->> 'contributed' = 'true';
          if not found then delete from hosted_provisioning where id = departure; end if;
        end if;
      end if;
      return null;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_member after insert or update of role or delete on member for each row execute function hosted_queue_member()`;
});
