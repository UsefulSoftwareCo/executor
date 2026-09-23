/** Durable lifecycle handoff, committed by the same transaction as auth changes. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

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
