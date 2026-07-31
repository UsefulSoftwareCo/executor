/* oxlint-disable executor/no-try-catch-or-throw -- boundary: out-of-band migration script over a raw postgres connection */
// ---------------------------------------------------------------------------
// One-off data backfill: mint `subject` rows for principals that predate the
// subject table (added by migration 0012, written only on sightings from then
// on).
//
//   bun run db:backfill-subjects:prod   # op run --env-file=.env.production
//   bun run db:backfill-subjects:dev    # against the local PGlite dev db
//
// Source of truth is the `connection` table: before 0012, "which users exist
// under this tenant" was answerable only through connection rows, so a distinct
// (tenant, subject) there — excluding the org sentinel '' — is exactly the set
// of users the admin console under-reports until their next request.
//
//   created_at   ← the tenant+subject's oldest connection, the closest honest
//                  answer to "when did this user first appear".
//   last_seen_at ← the tenant+subject's newest connection `updated_at`, the
//                  latest activity storage can attest to. Rendering every
//                  pre-0012 user as "Never" was literally true of the sighting
//                  column but reads as "inactive user" to an operator, which
//                  is the wrong answer for a tenant full of active people. The
//                  first real sighting overwrites this with request truth.
//
// Idempotent — the insert's ON CONFLICT on the (tenant, external_id) unique
// index leaves rows the runtime has since minted (or a prior run inserted)
// untouched, and the last_seen_at repair only fills NULLs — so re-running is
// safe and never rewinds a live row's fields.
// Pass --dry-run to print the plan without writing.
// ---------------------------------------------------------------------------

import postgres from "postgres";
import { createId } from "@executor-js/fumadb/cuid";

const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });

const rows = await sql<
  { tenant: string; subject: string; first_connection_at: Date; last_activity_at: Date }[]
>`
  SELECT tenant, subject,
         MIN(created_at) AS first_connection_at,
         MAX(updated_at) AS last_activity_at
  FROM connection
  WHERE subject <> ''
  GROUP BY tenant, subject
  ORDER BY tenant, subject
`;
console.log(`${rows.length} (tenant, subject) pair(s) with connections`);

let inserted = 0;
let repaired = 0;
for (const row of rows) {
  console.log(
    `${row.tenant}  ${row.subject}  first connection ${row.first_connection_at.toISOString()}  last activity ${row.last_activity_at.toISOString()}`,
  );
  if (dryRun) continue;
  const lastSeenMs = row.last_activity_at.getTime();
  const result = await sql`
    INSERT INTO subject (row_id, tenant, external_id, created_at, last_seen_at, status)
    VALUES (${createId()}, ${row.tenant}, ${row.subject}, ${row.first_connection_at}, ${lastSeenMs}, NULL)
    ON CONFLICT (tenant, external_id) DO NOTHING
  `;
  inserted += result.count;
  if (result.count > 0) continue;
  // The row predates this run but may still carry NULL from a run of the
  // pre-repair version of this script. Fill it in; a sighted row keeps its
  // request-truth timestamp.
  const repair = await sql`
    UPDATE subject SET last_seen_at = ${lastSeenMs}
    WHERE tenant = ${row.tenant} AND external_id = ${row.subject} AND last_seen_at IS NULL
  `;
  repaired += repair.count;
}

console.log(
  dryRun
    ? `dry run — would insert up to ${rows.length} row(s)`
    : `inserted ${inserted} row(s), repaired last_seen_at on ${repaired} row(s)`,
);
await sql.end();
