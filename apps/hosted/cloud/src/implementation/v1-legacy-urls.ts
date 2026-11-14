/**
 * The v1 URLs v2 serves on `executor.sh` after v1 shuts down (`notes/v1-shutdown.md`): which v2
 * organization each v1 organization's slug and id name, and which v2 connection is each member's
 * copy of each v1 toolkit. Two small permanent tables, apart from the import's: new imports write
 * them at cutover and a one-off backfill writes them for organizations moved before, both through
 * {@link recordLegacyUrls}, so the import can be deleted while the URLs keep resolving.
 *
 * Invariants: a v1 slug and a v1 organization id each name exactly one v2 organization (several
 * v1 organizations may name one v2 organization); a v2 organization, user or connection deleted
 * since takes its rows with it.
 */
import { Effect, Schema } from "effect";
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

/** One v1 toolkit: its storage row, its own key (v1's order among equal slugs), slug and owner. */
export interface LegacyToolkit {
  readonly row: string;
  readonly key: string;
  readonly slug: string;
  readonly orgOwned: boolean;
}

/** What one moved v1 organization's URLs name. */
export interface LegacyOrganization {
  readonly v1Organization: string;
  readonly v1Slug: string;
  readonly v2Organization: string;
  readonly toolkits: ReadonlyArray<LegacyToolkit>;
}

/** Another moved v1 organization already holds the slug; its URLs would be ambiguous. */
export class LegacySlugTaken extends Schema.TaggedError<LegacySlugTaken>()("LegacySlugTaken", {
  slug: Schema.String,
  holder: Schema.String,
}) {
  get message() {
    return `The v1 slug ${this.slug} already names v1 organization ${this.holder}.`;
  }
}

const Holders = Schema.Array(Schema.Struct({ v1_org_id: Schema.String }));
const Written = Schema.Array(Schema.Struct({ toolkits: Schema.Number }));

/**
 * Replace the organization's rows, in one transaction. Each toolkit's rows are its members' copies
 * that the import map records as imported and that are still their live connections in the
 * organization; members are mapped through the map's `user` rows. Where a member had the
 * organization's toolkit and their own with one slug, the organization's wins, then the lower key,
 * as v1 resolved a toolkit URL. Fails with {@link LegacySlugTaken} when another v1 organization
 * holds the slug. Returns how many toolkit rows it wrote.
 */
export const recordLegacyUrls = (organization: LegacyOrganization) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const holders = yield* sql`
          select v1_org_id from private_v1_legacy_org
          where v1_slug = ${organization.v1Slug} and v1_org_id <> ${organization.v1Organization}
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holders)));
        const holder = holders[0];
        if (holder !== undefined)
          return yield* new LegacySlugTaken({
            slug: organization.v1Slug,
            holder: holder.v1_org_id,
          });
        yield* sql`delete from private_v1_legacy_org where v1_org_id = ${organization.v1Organization}`;
        yield* sql`
          insert into private_v1_legacy_org (v1_org_id, v1_slug, v2_org_id)
          values (${organization.v1Organization}, ${organization.v1Slug}, ${organization.v2Organization})
        `;
        const toolkits = JSON.stringify(
          organization.toolkits.map((toolkit) => ({
            toolkit_row: toolkit.row,
            toolkit_key: toolkit.key,
            slug: toolkit.slug,
            org_owned: toolkit.orgOwned,
          })),
        );
        const written = yield* sql`
          with copies as (
            select distinct on (t.slug, u.v2_id)
              t.slug, u.v2_id as user_id, m.v2_id as connection_id, t.toolkit_row, t.org_owned
            from jsonb_to_recordset(${toolkits}::jsonb)
              as t(toolkit_row text, toolkit_key text, slug text, org_owned boolean)
            join private_v1_import_map m
              on m.v1_kind = 'toolkit' and m.status = 'imported' and m.v2_id is not null
              and m.v1_org_id = ${organization.v1Organization}
              and starts_with(m.v1_id, t.toolkit_row || ':')
            join private_v1_import_map u
              on u.v1_kind = 'user' and u.status = 'imported' and u.v2_id is not null
              and u.v1_id = substr(m.v1_id, length(t.toolkit_row) + 2)
            join "mcpConnection" c
              on c.id = m.v2_id and c."userId" = u.v2_id
              and c.resource = ${organization.v2Organization} and c.revoked is not true
            order by t.slug, u.v2_id, t.org_owned desc, t.toolkit_key
          ), inserted as (
            insert into private_v1_legacy_toolkit
              (v1_org_id, toolkit_slug, v2_user_id, connection_id, v1_toolkit_row, org_owned)
            select ${organization.v1Organization}, slug, user_id, connection_id, toolkit_row,
              org_owned
            from copies
            returning 1
          )
          select count(*)::int as toolkits from inserted
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Written)));
        return { toolkits: written[0]?.toolkits ?? 0 };
      }),
    );
  });

/** Remove the organization's rows, as its rollback does. */
export const forgetLegacyUrls = (v1Organization: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`delete from private_v1_legacy_org where v1_org_id = ${v1Organization}`,
  ).pipe(Effect.asVoid);
