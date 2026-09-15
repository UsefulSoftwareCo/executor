// ---------------------------------------------------------------------------
// One-off data backfill: fill the membership mirror (`accounts` profile
// columns + `memberships` rows, migration 0018) from WorkOS for every
// organization the mirror already knows.
//
//   bun run db:backfill-workos-mirror:prod   # op run --env-file=.env.production
//   bun run db:backfill-workos-mirror:dev    # against the local PGlite dev db
//
// For each row in `organizations`: list its active + pending memberships,
// fetch each member's user (concurrency 5), upsert user + membership through
// the same guarded store the request path uses (`auth/workos-mirror-store.ts`).
// Idempotent — the upserts refuse anything older than the stored WorkOS
// `updatedAt`, so re-running is safe and never rewinds a fresher row.
// Pass --dry-run to read and count without writing.
//
// DEPLOY ORDER: run this against production BEFORE deploying the build that
// reads member lists and seat counts from the mirror. A completed run stamps
// the `workos_sync` "backfill" marker; until it exists, seat reporting to
// Autumn is skipped (with a warning) rather than pushing a partial count, and
// member lists show only the members who have signed in since the mirror
// shipped. Verify the printed membership count against the WorkOS dashboard.
// ---------------------------------------------------------------------------

import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import postgres from "postgres";
import { WorkOS } from "@workos-inc/node";

import { backfillWorkOsMirror } from "../src/auth/workos-mirror-backfill";
import { makeWorkOsMirrorStore } from "../src/auth/workos-mirror-store";
import { organizations } from "../src/db/schema";

const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const apiKey = process.env.WORKOS_API_KEY;
if (!apiKey) {
  console.error("WORKOS_API_KEY is not set");
  process.exit(1);
}

const usesLocalDatabase =
  connectionString.includes("127.0.0.1") || connectionString.includes("localhost");

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
  ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
});
const db = drizzle(sql);
const workos = new WorkOS(apiKey);

// The script boundary: raw SDK / driver promises lifted once, here.
const fromPromise = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => cause });

await Effect.runPromise(
  backfillWorkOsMirror(
    {
      listOrganizationIds: () =>
        fromPromise(async () => {
          const rows = await db
            .select({ id: organizations.id })
            .from(organizations)
            .orderBy(asc(organizations.createdAt));
          return rows.map((row) => row.id);
        }),
      listOrgMembers: (organizationId) =>
        fromPromise(async () => {
          const page = await workos.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active", "pending"],
          });
          return page.listMetadata.after ? page.autoPagination() : page.data;
        }),
      getUser: (userId) => fromPromise(() => workos.userManagement.getUser(userId)),
    },
    makeWorkOsMirrorStore(db),
    { dryRun, log: (line) => console.log(line) },
  ).pipe(Effect.ensuring(Effect.promise(() => sql.end({ timeout: 5 })))),
);
