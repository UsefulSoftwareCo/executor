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
//   - `workos_sync`    — the WorkOS Events API cursor the reconciler resumes from
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
 * membership status (`active` / `pending` / `inactive`).
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.organizationId] }),
    membershipIdUnique: uniqueIndex("memberships_membership_id_unique").on(t.membershipId),
    organizationIdx: index("memberships_organization_id_idx").on(t.organizationId),
  }),
);

/**
 * The WorkOS Events API cursor. One row per stream (`id` names the stream;
 * the reconciler uses `"events"`), holding the id of the last event applied.
 * Advanced only by compare-and-set, so two concurrent reconciler runs cannot
 * both believe they own the stream: the loser's CAS fails and it stops.
 */
export const workosSync = pgTable("workos_sync", {
  id: text("id").primaryKey(),
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
