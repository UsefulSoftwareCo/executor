/**
 * One-off backfill of the v1 URL tables (`notes/v1-shutdown.md`) for organizations that cut over
 * before imports wrote them. It reads v2's import records and v1's `organizations` and
 * `plugin_storage` rows (read-only), and writes each organization's rows with the import's own
 * writer (`recordLegacyUrls`).
 *
 *   DATABASE_URL=<v2> V1_DATABASE_URL=<v1, read-only role> \
 *     node apps/hosted/cloud/scripts/v1-legacy-urls.ts            # dry run: writes nothing
 *   ... node apps/hosted/cloud/scripts/v1-legacy-urls.ts --apply  # writes
 *   ... --organization <v1 org id> [--organization ...]           # only these organizations
 *
 * The dry run runs every write in one transaction and rolls it back, so its counts are the apply's.
 * It refuses, and reports by v1 organization id:
 * - a v1 slug two cut-over organizations claim (neither is written);
 * - a v2 organization that no longer exists (not written);
 * - an organization v1 no longer has: written with the slug its import report recorded, or
 *   refused when it recorded none.
 * Each toolkit copy the import map records that no row was written for is counted. It prints ids
 * and counts only. Safe to re-run: each organization's rows are replaced.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { PgClient } from "@effect/sql-pg";
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { ToolkitData } from "../src/implementation/v1-import/formats.ts";
import { recordLegacyUrls, type LegacyOrganization } from "../src/implementation/v1-legacy-urls.ts";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    organization: { type: "string", multiple: true },
  },
});
/** The organizations to write, when the operator names some; every cut-over one otherwise. */
const only = values.organization === undefined ? undefined : new Set(values.organization);

const Moved = Schema.Array(
  Schema.Struct({
    v1_org_id: Schema.String,
    v2_org_id: Schema.String,
    recorded_slug: Schema.NullOr(Schema.String),
    live: Schema.Boolean,
    copies: Schema.Number,
  }),
);
const V1Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const V1Toolkits = Schema.Array(
  Schema.Struct({
    tenant: Schema.String,
    row_id: Schema.String,
    key: Schema.String,
    owner: Schema.String,
    data: Schema.Unknown,
  }),
);

/** The dry run's rollback; never an error of the backfill. */
class DryRun extends Schema.TaggedError<DryRun>()("DryRun", {}) {}

/** v1's rows for the organizations, in one read-only transaction of the read-only role. */
const readV1 = (url: Redacted.Redacted<string>, organizations: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
    (pool) =>
      Effect.promise(async () => {
        const client = await pool.connect();
        try {
          await client.query("begin transaction read only");
          const found = await client.query(
            "select id, slug from organizations where id = any($1::text[])",
            [organizations],
          );
          const toolkits = await client.query(
            `select tenant, row_id, key, owner, data from plugin_storage
             where plugin_id = 'toolkits' and collection = 'toolkits' and tenant = any($1::text[])`,
            [organizations],
          );
          await client.query("rollback");
          return { organizations: found.rows, toolkits: toolkits.rows };
        } finally {
          client.release();
        }
      }),
    (pool) => Effect.promise(() => pool.end()),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.all({
        organizations: Schema.decodeUnknownEffect(V1Organizations)(rows.organizations),
        toolkits: Schema.decodeUnknownEffect(V1Toolkits)(rows.toolkits),
      }),
    ),
  );

/** A toolkit row's data, stored as JSON text or as a decoded column. */
const toolkitData = (data: unknown) =>
  typeof data === "string"
    ? Schema.decodeUnknownOption(Schema.fromJsonString(ToolkitData))(data)
    : Schema.decodeUnknownOption(ToolkitData)(data);

const backfill = Effect.gen(function* () {
  const v1Url = yield* Config.Redacted("V1_DATABASE_URL");
  const sql = yield* SqlClient.SqlClient;
  const moved = yield* sql`
    select o.v1_org_id, m.v2_id as v2_org_id,
      o.report -> 'slug' ->> 'v1' as recorded_slug,
      exists (select 1 from organization where id = m.v2_id) as live,
      (select count(*)::int from private_v1_import_map t
        where t.v1_kind = 'toolkit' and t.v1_org_id = o.v1_org_id and t.status = 'imported')
        as copies
    from private_v1_import_org o
    join private_v1_import_map m
      on m.v1_kind = 'organization' and m.v1_id = o.v1_org_id and m.status = 'imported'
      and m.v2_id is not null
    where o.state = 'cutover'
    order by o.v1_org_id
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Moved)),
    Effect.map((rows) =>
      only === undefined ? rows : rows.filter((row) => only.has(row.v1_org_id)),
    ),
  );
  const v1 = yield* readV1(
    v1Url,
    moved.map((row) => row.v1_org_id),
  );
  const slugs = new Map(v1.organizations.map((row) => [row.id, row.slug]));
  const refused: Array<{ readonly organization: string; readonly reason: string }> = [];
  const planned: Array<LegacyOrganization & { readonly copies: number }> = [];
  for (const row of moved) {
    if (!row.live) {
      refused.push({ organization: row.v1_org_id, reason: "its v2 organization was deleted" });
      continue;
    }
    const slug = slugs.get(row.v1_org_id) ?? row.recorded_slug;
    if (slug === null) {
      refused.push({
        organization: row.v1_org_id,
        reason: "v1 has no row and no slug was recorded",
      });
      continue;
    }
    planned.push({
      v1Organization: row.v1_org_id,
      v1Slug: slug,
      v2Organization: row.v2_org_id,
      copies: row.copies,
      toolkits: v1.toolkits
        .filter((toolkit) => toolkit.tenant === row.v1_org_id)
        .flatMap((toolkit) =>
          Option.match(toolkitData(toolkit.data), {
            onNone: () => [],
            onSome: (data) => [
              {
                row: toolkit.row_id,
                key: toolkit.key,
                slug: data.slug,
                orgOwned: toolkit.owner === "org",
              },
            ],
          }),
        ),
    });
  }
  // A slug two organizations claim would make their URLs ambiguous: neither is written.
  const claims = new Map<string, number>();
  for (const organization of planned)
    claims.set(organization.v1Slug, (claims.get(organization.v1Slug) ?? 0) + 1);
  const writable = planned.filter((organization) => {
    if ((claims.get(organization.v1Slug) ?? 0) < 2) return true;
    refused.push({
      organization: organization.v1Organization,
      reason: "another cut-over organization claims its v1 slug",
    });
    return false;
  });
  const write = Effect.gen(function* () {
    let written = 0;
    let toolkitRows = 0;
    let toolkitCopiesWithoutRow = 0;
    for (const organization of writable) {
      const result = yield* recordLegacyUrls(organization).pipe(
        Effect.map(Option.some),
        Effect.catchTag("LegacySlugTaken", (taken) =>
          Effect.sync(() => {
            refused.push({
              organization: organization.v1Organization,
              reason: `its v1 slug already names ${taken.holder}`,
            });
            return Option.none();
          }),
        ),
      );
      if (Option.isNone(result)) continue;
      written += 1;
      toolkitRows += result.value.toolkits;
      toolkitCopiesWithoutRow += Math.max(0, organization.copies - result.value.toolkits);
    }
    const summary = {
      mode: values.apply ? "apply" : "dry run",
      cutOver: moved.length,
      written,
      fromRecordedSlug: writable.filter((o) => !slugs.has(o.v1Organization)).length,
      toolkitRows,
      // Copies of a personal toolkit the organization's shadows by slug, revoked copies, and
      // copies whose member is no longer mapped: v1 would not serve them at that URL either.
      toolkitCopiesWithoutRow,
      refused,
    };
    yield* Console.log(JSON.stringify(summary, null, 2));
    if (!values.apply) return yield* new DryRun();
  });
  yield* sql.withTransaction(write).pipe(Effect.catchTag("DryRun", () => Effect.void));
});

NodeRuntime.runMain(
  backfill.pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.map(Config.Redacted("DATABASE_URL"), (url) =>
          PgClient.layer({ url, maxConnections: 1 }),
        ),
      ),
    ),
  ),
);
