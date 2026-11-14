/** Fresh hosted policy tables; every resource receives policy in its creation transaction. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Caller holds the hosted migration lock after SDK and group tables exist. */
export const migrateResourceAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create unique index if not exists hosted_groups_organization_identity on hosted_groups (organization_id, id)`;
  yield* sql`create table if not exists hosted_app_access (
    id text primary key references executor_apps(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    audience text not null check (audience in ('private', 'groups', 'everyone')),
    revision text not null default gen_random_uuid()::text,
    unique (organization_id, id)
  )`;
  yield* sql`create table if not exists hosted_app_groups (
    organization_id text not null,
    app_id text not null,
    group_id text not null,
    primary key (app_id, group_id),
    foreign key (organization_id, app_id) references hosted_app_access(organization_id, id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`;
  yield* sql`create table if not exists hosted_account_access (
    account_id text primary key references executor_accounts(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    kind text not null check (kind in ('personal', 'shared')),
    personal_user_id text,
    audience text check (audience in ('groups', 'everyone')),
    revision text not null default gen_random_uuid()::text,
    check ((kind = 'personal' and personal_user_id is not null and audience is null)
      or (kind = 'shared' and personal_user_id is null and audience is not null)),
    unique (organization_id, account_id)
  )`;
  yield* sql`create table if not exists hosted_account_groups (
    organization_id text not null,
    account_id text not null,
    group_id text not null,
    primary key (account_id, group_id),
    foreign key (organization_id, account_id) references hosted_account_access(organization_id, account_id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`;
  yield* sql`create table if not exists hosted_connection_access (
    connection_id text primary key references executor_account_connections(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text not null references "user"(id) on delete cascade,
    destination jsonb not null,
    target jsonb
  )`;
});

/**
 * Accounts are no longer shared with groups. A sign-in request saved to create a group-shared
 * account would now complete as an account for the whole organization, so its access record is
 * removed: the request is refused and its creator starts again. Saved accounts are not changed
 * here: one whose audience is still `groups` is used by nobody, and its creator and the
 * organization's admins can delete it. `hosted_account_groups` stays until no running server
 * reads it.
 */
export const removeGroupAccountConnections = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`delete from hosted_connection_access
    where destination ->> 'kind' = 'shared' and destination -> 'audience' ->> 'kind' = 'groups'`;
});
