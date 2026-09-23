/** Additive hosted-only group storage. Existing resource and auth rows are unchanged. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Run under the hosted migration lock after Better Auth has created its organization/member tables. */
export const migrateGroups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_groups (
    id text primary key default gen_random_uuid()::text,
    organization_id text not null references organization(id) on delete cascade,
    name text not null check (length(name) between 1 and 80 and name = btrim(name)),
    description text not null default '' check (length(description) <= 240),
    revision text not null default gen_random_uuid()::text
  )`;
  yield* sql`create unique index if not exists hosted_groups_org_name on hosted_groups (organization_id, lower(name))`;
  yield* sql`create table if not exists hosted_group_members (
    group_id text not null references hosted_groups(id) on delete cascade,
    member_id text not null references member(id) on delete cascade,
    primary key (group_id, member_id)
  )`;
  yield* sql`create index if not exists hosted_group_members_member on hosted_group_members (member_id)`;
});
