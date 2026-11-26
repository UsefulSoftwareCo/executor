import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const migrateOrganizationRemovals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_organization_removal (
    organization_id text primary key,
    instance_id text not null,
    status text not null default 'running' check (status in ('running', 'done')),
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    logo text,
    check ((status = 'done') = (finished_at is not null))
  )`;
});
