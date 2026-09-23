/** Additive removal tombstones. No existing organization, member or auth row is changed. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Run under the hosted migration lock. This table deliberately has no foreign
 * key to `organization`: its whole purpose is to outlive the organization row
 * that one of its own steps deletes, and to keep the organization hidden until
 * the workflow reports the erasure finished.
 */
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
