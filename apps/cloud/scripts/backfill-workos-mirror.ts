// ---------------------------------------------------------------------------
// One-off data backfill: fill the membership mirror (`accounts` profile
// columns + `memberships` rows, migration 0018) from WorkOS for every
// organization the mirror already knows.
//
//   bun run db:backfill-workos-mirror:prod   # op run --env-file=.env.production
//   bun run db:backfill-workos-mirror:dev    # against the local PGlite dev db
//
// For each live row in `organizations`: list EVERY membership WorkOS holds
// for it (active, pending, and inactive — a listing that skipped inactive
// ones would have the scan tombstone them, see `auth/workos-mirror-backfill.ts`),
// fetch each member's user (concurrency 5), and apply the listing in one
// transaction through the same guarded store the request path
// uses (`auth/workos-mirror-store.ts`): upsert user + membership, tombstone
// any mirrored membership of that org WorkOS no longer lists, and mark the
// org backfilled (`organizations.backfilled_at`) — the per-org mark the seat
// gates check before trusting a count from the mirror; an org left unmarked
// is scanned on demand the first time its seats are counted. Idempotent —
// the upserts refuse anything older than the stored WorkOS `updatedAt`, so
// re-running is safe, never rewinds a fresher row, and repairs a stale one;
// and a listing older than one already applied (two runs overlapping) is
// refused whole, so it cannot resurrect a membership the later listing found
// gone. Pass --dry-run to read and count without writing.
//
// DEPLOY ORDER: run this against production BEFORE deploying the builds that
// reconcile from the Events API and read seat counts from the mirror, so no
// request pays for an on-demand scan. The FIRST run records the events
// replay boundary BEFORE it lists anything (the reconciler's first run reads
// from it; without one it waits); later runs — a retry included — keep it,
// since only the events stream covers the org renames and user deletions
// after that instant. A run that fails part-way keeps the marks of the orgs
// it finished and the boundary it recorded, and is safe to repeat. Verify
// the printed membership count against the WorkOS dashboard.
// ---------------------------------------------------------------------------

import { asc, isNull } from "drizzle-orm";
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
          // Never a deleted organization: its row is a tombstone (its
          // memberships are purged, WorkOS no longer has it) and the mirror
          // refuses a scan of it anyway.
          const rows = await db
            .select({ id: organizations.id })
            .from(organizations)
            .where(isNull(organizations.deletedAt))
            .orderBy(asc(organizations.createdAt));
          return rows.map((row) => row.id);
        }),
      listOrgMembers: (organizationId) =>
        fromPromise(async () => {
          const page = await workos.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active", "pending", "inactive"],
          });
          return page.listMetadata.after ? page.autoPagination() : page.data;
        }),
      getUser: (userId) => fromPromise(() => workos.userManagement.getUser(userId)),
    },
    makeWorkOsMirrorStore(db),
    { dryRun, log: (line) => console.log(line) },
  ).pipe(Effect.ensuring(Effect.promise(() => sql.end({ timeout: 5 })))),
);
