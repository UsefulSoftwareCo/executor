import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrationFailed } from "@executor-js/hosted-server/migrations";

export const migrateV1LegacyUrls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists private_v1_legacy_org (
    v1_org_id text primary key,
    v1_slug text not null unique,
    v2_org_id text not null references organization(id) on delete cascade,
    recorded_at timestamptz not null default now()
  )`;
  yield* sql`create index if not exists private_v1_legacy_org_v2
    on private_v1_legacy_org (v2_org_id)`;
  yield* sql`create table if not exists private_v1_legacy_toolkit (
    v1_org_id text not null references private_v1_legacy_org(v1_org_id) on delete cascade,
    toolkit_slug text not null,
    v2_user_id text not null references "user"(id) on delete cascade,
    connection_id text not null
      references "mcpConnection"(id) on delete cascade on update cascade,
    v1_toolkit_row text not null,
    org_owned boolean not null,
    primary key (v1_org_id, toolkit_slug, v2_user_id)
  )`;
}).pipe(Effect.mapError(migrationFailed("product")));
