/**
 * The v1 URLs v2 serves on `executor.sh` after v1 shuts down (`notes/v1-shutdown.md`): which v2
 * organization each v1 organization's slug and id name, and which v2 connection is each member's
 * copy of each v1 toolkit. Two small permanent tables, apart from the import's: the import wrote
 * them at cutover and a one-off backfill wrote them for organizations moved before, so the URLs
 * keep resolving now that the import is deleted. Nothing writes them any more.
 *
 * Invariants: a v1 slug and a v1 organization id each name exactly one v2 organization (several
 * v1 organizations may name one v2 organization); a v2 organization, user or connection deleted
 * since takes its rows with it.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { migrationFailed } from "@executor-js/hosted-server/migrations";

/**
 * The two tables. Additive: no running server reads them before the edge routes ship, and the
 * running import never reads them.
 */
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
