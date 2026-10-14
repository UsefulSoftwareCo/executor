/** Access records for OAuth clients, beside the executor's stored clients they describe. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Additive: two new tables the running server never reads. A client without a record is usable
 * by nobody, so a client created before its record commits stays hidden, never exposed.
 */
export const migrateOAuthClientAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_oauth_client_access (
    client_id text primary key references executor_stored_oauth_clients(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    audience text not null check (audience in ('private', 'groups', 'everyone')),
    revision text not null default gen_random_uuid()::text,
    unique (organization_id, client_id)
  )`;
  yield* sql`create table if not exists hosted_oauth_client_groups (
    organization_id text not null,
    client_id text not null,
    group_id text not null,
    primary key (client_id, group_id),
    foreign key (organization_id, client_id) references hosted_oauth_client_access(organization_id, client_id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`;
});
