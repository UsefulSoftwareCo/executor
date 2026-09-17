// ---------------------------------------------------------------------------
// Cloud-specific identity & multi-tenancy tables
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical user/membership data. We mirror it locally:
//
//   - `accounts`       — login identity + profile (foreign key anchor for
//                        created_by, etc.; email/name/avatar for member lists)
//   - `organizations`  — billing entity, scoping root for all domain data
//   - `memberships`    — which accounts belong to which organizations, with
//                        the WorkOS role and status
//   - `workos_sync`    — the WorkOS Events API cursor the reconciler resumes
//                        from, and the replay boundary the one-off backfill
//                        records
//
// The mirror is fed by login (the callback has the user + memberships in
// hand), write-through on every Executor-initiated change, and the WorkOS
// Events API (dashboard-side changes). It is the read path for membership and
// member lists — WorkOS is a write target and an event source, never a
// per-request read. Invitations are NOT mirrored; they stay live in WorkOS.
//
// `workos_updated_at` on `accounts` and `memberships` is the WorkOS
// `updatedAt` of the payload that last wrote the row. Every upsert is guarded
// on it, so feeders can be replayed and reordered without an older payload
// clobbering a newer one.

import { sql } from "drizzle-orm";
import { index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Login identity + mirrored WorkOS profile. The `id` is the WorkOS user ID.
 * Profile columns are nullable because a row can be minted by `ensureAccount`
 * (an api-key path, a membership arriving before its user event) with nothing
 * but the id; the next user payload fills them in.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    avatarUrl: text("avatar_url"),
    /** WorkOS `updatedAt` of the user payload that last wrote this row. */
    workosUpdatedAt: timestamp("workos_updated_at", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // `findByEmail` and the search filter compare lower-cased; the index
    // matches that expression so the lookup stays indexed.
    emailLowerIdx: index("accounts_email_lower_idx").on(sql`lower(${t.email})`),
  }),
);

/**
 * Organization (billing entity, scoping root). The `id` is the WorkOS
 * organization ID. The `slug` is OURS, not WorkOS's (their org object has no
 * slug): minted at the moment a row is inserted (the single mint point is
 * `upsertOrganization`) and stable across renames so org URLs don't break.
 * NOT NULL — there is no nullable window: legacy rows were backfilled once and
 * every insert since carries a slug.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * When this organization's membership list was last FULLY scanned from
     * WorkOS (the one-off backfill, or the on-demand scan a seat count
     * triggers), or null if it never was. Until then the mirror may hold only
     * the members login and write-through happened to record, so a count read
     * from it is partial; every seat gate checks this mark first. Per
     * organization, never database-wide: an org mirrored lazily after a
     * backfill ran starts unmarked and is scanned on its first count. The
     * mark also orders membership writes: a payload stamped before it is
     * refused, since the scan was the full listing at that instant and a
     * membership it did not contain was revoked before it — before the
     * events replay boundary, so nothing would tombstone it again.
     */
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    /**
     * When this organization was deleted, or null while it is live. Set FIRST
     * by cloud's own deletion flow (`auth/handlers.ts` deleteOrganization),
     * before the WorkOS delete and the local purge, and by the
     * `organization.deleted` event for an org deleted in the WorkOS dashboard
     * — which MINTS the row as a tombstone when the mirror has never seen the
     * organization: membership is authorized from the local mirror, so a
     * marked organization refuses every session at once, whether or not the
     * later steps land. Membership rows are left as they are until the purge
     * (so the admin who started the deletion can retry it after a step
     * failed), and the purge (`db/org-deletion.ts`) removes them but KEEPS
     * this row as a tombstone: a feeder that fetched a membership before the
     * deletion and writes it after (a login that stalled across the deletion)
     * finds the tombstone and does not mint the organization live. A marked
     * organization is never renamed.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * The instant the stored `name` is known to have been the organization's
     * name in WorkOS: the WorkOS `updatedAt` of the organization payload that
     * wrote it, or — for a name learned from a membership list at sign-in,
     * which carries no organization timestamp — the instant that list was
     * fetched. A name write stamped earlier than this is refused
     * (`upsertOrganization`), so a sign-in whose list predates a rename cannot
     * revert it. Null only on rows written before the stamp existed.
     */
    workosUpdatedAt: timestamp("workos_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("organizations_slug_unique").on(t.slug),
  }),
);

/**
 * Account ↔ organization link, mirroring the WorkOS organization membership.
 * Answers "which workspaces does this account belong to?" and "is this caller
 * an active member with which role?" without a WorkOS round-trip, and gives
 * per-(account, organization) data a foreign key to point at.
 *
 * `membershipId` is the WorkOS `om_…` id — nullable only because rows written
 * before the mirror existed carry none; every feeder sets it. `role` is the
 * WorkOS role slug as issued (`admin` / `member`); `status` is the WorkOS
 * membership status (`active` / `pending` / `inactive`). A membership deleted
 * in WorkOS is never dropped here: it is tombstoned as `inactive` with
 * `deleted_at` set, so a feeder replaying an older payload cannot resurrect it.
 *
 * `deleted_at` means "the membership under `membership_id` was DELETED in
 * WorkOS" — an identity fact, not a timestamp to order payloads by. WorkOS
 * never reuses a deleted `om_…` id, so any payload naming that id is stale
 * however it is stamped, and a payload naming a DIFFERENT id for the same
 * (account, organization) is the member re-added: a replacement, ordered by
 * `workos_updated_at` like every other write. Distinct from `status =
 * 'inactive'` with `deleted_at` null, which is a membership WorkOS
 * deactivated but still holds and can reactivate under the same id.
 */
export const memberships = pgTable(
  "memberships",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: text("membership_id"),
    role: text("role").notNull().default("member"),
    status: text("status", { enum: ["active", "pending", "inactive"] })
      .notNull()
      .default("active"),
    /** WorkOS `updatedAt` of the membership payload that last wrote this row. */
    workosUpdatedAt: timestamp("workos_updated_at", { withTimezone: true }),
    /**
     * When the membership under `membership_id` was deleted in WorkOS, or null
     * while WorkOS still holds it (whatever its `status`). Set once; cleared
     * only when a replacement membership (another id) takes the row over.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.organizationId] }),
    membershipIdUnique: uniqueIndex("memberships_membership_id_unique").on(t.membershipId),
    organizationIdx: index("memberships_organization_id_idx").on(t.organizationId),
  }),
);

/**
 * Every WorkOS membership id (`om_…`) a DELETE has named, keyed by that id
 * alone. The `memberships` row is keyed by (account, organization) and holds
 * ONE membership id, so a row-level tombstone can only record the deletion of
 * the id the row happens to carry: a delete of membership B arriving while
 * the row still holds an older membership A of the same pair (A replaced by
 * B in WorkOS before the mirror saw either, B then deleted) has no row to
 * tombstone, and a later payload of B — stamped after A, under another id —
 * would take the row over live. This ledger is what the mirror consults
 * instead: a delete always records the id here, whatever the row holds, and
 * no membership write ever names a recorded id again, however it is stamped
 * — WorkOS never reuses a deleted `om_…` id. `deleted_at` records when; it
 * orders nothing. Rows cascade with their account and organization.
 */
export const membershipTombstones = pgTable(
  "membership_tombstones",
  {
    membershipId: text("membership_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    organizationIdx: index("membership_tombstones_organization_id_idx").on(t.organizationId),
  }),
);

/**
 * The WorkOS Events API sync state. One row per stream (`id` names the
 * stream; the reconciler uses `"events"`), holding the id of the last event
 * applied. Advanced only by compare-and-set, so two concurrent reconciler
 * runs cannot both believe they own the stream: the loser's CAS fails and it
 * stops.
 *
 * `range_start` on the `"events"` row is the REPLAY BOUNDARY: the instant the
 * FIRST one-off backfill run (`scripts/backfill-workos-mirror.ts`) began
 * reading WorkOS, recorded BEFORE its first listing. Everything before it is
 * covered by that backfill; the reconciler's first run (no cursor yet) reads
 * the events stream from here, so a revocation between the backfill and the
 * first run is never skipped. Written once: a run that fails part-way leaves
 * it standing and its retry keeps it, and a later run keeps it too, because
 * the backfill does not refresh everything the events stream carries
 * (organization renames, deleted users' profiles) — those after the first
 * boundary are replayed from it. Without a cursor or a boundary the
 * reconciler does not guess; it waits for the backfill.
 *
 * `backfill_completed_at` is when a backfill run first wrote EVERY live
 * organization (`scripts/backfill-workos-mirror.ts` completing, or refusing
 * an organization only because a later listing was already applied). Until
 * it is set, the mirror may lack members who have not signed in since it
 * shipped, so a membership check read from it would deny them: it is the
 * first half of the mirror-readiness mark the authorization path consults
 * before trusting the mirror over WorkOS. Write-once — a later completed run
 * keeps the first instant, so readiness never flips back. Per-organization
 * completeness for the seat gates is tracked separately
 * (`organizations.backfilled_at`).
 *
 * `drained_at` is when a reconciler run last read the events stream to its
 * END (an empty page, or a page with nothing after it) — the second half of
 * the readiness mark: a mirror whose reconciler has not caught up recently
 * may still grant a member WorkOS already revoked, so the authorization
 * path trusts the mirror only while this is within its lag budget. Moved
 * forward by every draining run; never cleared. A run that stops at its
 * page budget or yields to another run leaves it as it was.
 *
 * Migration 0019 seeds the boundary and the completion mark on a database
 * with no organizations, where there is nothing to backfill; `drained_at`
 * is left for the reconciler's first run to set (migration 0020).
 */
export const workosSync = pgTable("workos_sync", {
  id: text("id").primaryKey(),
  cursor: text("cursor"),
  rangeStart: timestamp("range_start", { withTimezone: true }),
  backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
  drainedAt: timestamp("drained_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
