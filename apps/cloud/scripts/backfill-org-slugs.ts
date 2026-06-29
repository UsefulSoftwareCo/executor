/* oxlint-disable executor/no-try-catch-or-throw -- boundary: out-of-band migration script over a raw postgres connection */
// ---------------------------------------------------------------------------
// One-off data backfill: mint URL slugs for organizations that predate the
// slug column (added by migration 0003, nullable).
//
//   bun run db:backfill-org-slugs:prod   # op run --env-file=.env.production
//   bun run db:backfill-org-slugs:dev    # against the local PGlite dev db
//
// Idempotent — already-slugged rows are skipped, so re-running is safe.
//
// Ordering matters: the runtime now mints a slug at the moment a row is
// inserted and NO LONGER self-heals null slugs, and migration 0004 makes the
// column NOT NULL. So this backfill is the SOLE way pre-existing null-slug rows
// get a slug, and it MUST run BEFORE 0004 is applied (a null row would fail the
// NOT NULL alter). The correct sequence is: backfill (this script) → deploy the
// mint-at-insert code → apply 0004.
// Pass --dry-run to print the plan without writing.
// ---------------------------------------------------------------------------

import postgres from "postgres";
import { generateOrgSlug } from "@executor-js/api";

const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });

const rows = await sql<{ id: string; name: string }[]>`
  SELECT id, name FROM organizations WHERE slug IS NULL ORDER BY created_at ASC
`;
console.log(`${rows.length} organization(s) without a slug`);

// Track in-flight assignments so a batch with duplicate names plans unique
// slugs without round-tripping after every insert.
const planned = new Set<string>();
const isTaken = async (slug: string) => {
  if (planned.has(slug)) return true;
  const hits = await sql`SELECT 1 FROM organizations WHERE slug = ${slug}`;
  return hits.length > 0;
};

let updated = 0;
for (const row of rows) {
  const slug = await generateOrgSlug(row.name, isTaken);
  planned.add(slug);
  console.log(`${row.id}  ${JSON.stringify(row.name)} -> ${slug}`);
  if (dryRun) continue;
  // Guard WHERE slug IS NULL keeps re-runs idempotent (and tolerates a row that
  // gained a slug between our read and this write).
  await sql`UPDATE organizations SET slug = ${slug} WHERE id = ${row.id} AND slug IS NULL`;
  updated += 1;
}

console.log(dryRun ? `dry run — would update ${rows.length} row(s)` : `updated ${updated} row(s)`);
await sql.end();
