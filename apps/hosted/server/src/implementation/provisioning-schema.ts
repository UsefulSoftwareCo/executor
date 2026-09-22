/** Durable lifecycle handoff, committed by the same transaction as auth changes. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Install the default app queue after auth tables; completion metadata preserves user deletions. */
export const migrateProvisioning = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_provisioning (
    id text primary key default gen_random_uuid()::text,
    kind text not null constraint hosted_provisioning_kind check (kind in ('team', 'member')),
    organization_id text references organization(id) on delete cascade,
    user_id text references "user"(id) on delete cascade,
    status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
    attempts integer not null default 0,
    available_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hosted_provisioning_subject check (
      (kind = 'member' and user_id is not null and organization_id is not null)
      or (kind = 'team' and organization_id is not null and user_id is null))
  )`;
  yield* sql`create index if not exists hosted_provisioning_pending on hosted_provisioning (available_at) where status in ('queued', 'running')`;
  yield* sql`create index if not exists hosted_provisioning_member on hosted_provisioning (organization_id, user_id, updated_at desc) where kind = 'member'`;
  yield* sql`create or replace function hosted_queue_team() returns trigger language plpgsql as $$
    begin
      insert into hosted_provisioning (id, kind, organization_id) values ('team-' || NEW.id, 'team', NEW.id) on conflict do nothing;
      return NEW;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_team after insert on organization for each row execute function hosted_queue_team()`;
  yield* sql`create or replace function hosted_queue_member() returns trigger language plpgsql as $$
    begin
      insert into hosted_provisioning (kind, organization_id, user_id) values ('member', NEW."organizationId", NEW."userId");
      return NEW;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_member after insert or update of role on member for each row execute function hosted_queue_member()`;
  yield* sql`create or replace function hosted_queue_user() returns trigger language plpgsql as $$
    begin
      if NEW."emailVerified" and (TG_OP = 'INSERT' or not OLD."emailVerified") then
        insert into hosted_provisioning (kind, organization_id, user_id)
          select 'member', "organizationId", NEW.id from member where "userId" = NEW.id;
      end if;
      return NEW;
    end $$`;
  yield* sql`create or replace trigger hosted_provision_user after insert or update of "emailVerified" on "user" for each row execute function hosted_queue_user()`;
  // Stable repair IDs make repeated migrations harmless. Defaults metadata preserves deletions.
  yield* sql`insert into hosted_provisioning (id, kind, organization_id)
    select 'team-' || id, 'team', id from organization on conflict do nothing`;
  yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
    select 'member-' || id, 'member', "organizationId", "userId" from member on conflict do nothing`;
});
