// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { and, eq, isNull, lte, or } from "drizzle-orm";

import { generateOrgSlug } from "@executor-js/api";

import { accounts, organizations } from "../db/schema";
import type { DrizzleDb } from "../db/db";
import { purgeOrganizationData } from "../db/org-deletion";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

/**
 * An organization as a feeder hands it to the mirror. `updatedAt` is when
 * `name` is known to have been the organization's name in WorkOS: the WorkOS
 * `updatedAt` of an organization payload, or the instant a membership list
 * naming the organization was fetched (a list carries the name but no
 * organization timestamp).
 */
export interface OrganizationPayload {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
}

/**
 * Which stored organization rows a name stamped `updatedAt` may rename: a
 * row with no stamp (predating the stamp), or one stamped at or before
 * `updatedAt` — feeders replay the same payload and must converge. Every
 * writer of `organizations.name` applies this, so a name fetched before a
 * rename can never revert the rename after it landed.
 */
export const organizationAcceptsName = (updatedAt: Date) =>
  or(isNull(organizations.workosUpdatedAt), lte(organizations.workosUpdatedAt, updatedAt));

const readOrganization = async (db: DrizzleDb, id: string) => {
  const rows = await db.select().from(organizations).where(eq(organizations.id, id));
  return rows[0] ?? null;
};

/**
 * Insert the organization row for `row.id` with a freshly minted URL slug,
 * and return the row now held for that id: the one inserted, or the one a
 * concurrent writer minted first. THE single mint point for slugs: every
 * organization row is born with one, so there is no nullable window and no
 * self-healing. With `deletedAt` set this mints a TOMBSTONE — the row an
 * organization deleted in WorkOS before the mirror ever saw it leaves
 * behind, so a feeder still holding a membership of it cannot mint it live
 * (`upsertOrganization` returns a marked row untouched).
 *
 * `ON CONFLICT DO NOTHING` (no target) absorbs BOTH unique violations
 * without throwing: an id collision (the org was mirrored concurrently),
 * which resolves to the row now held, and a slug collision (the candidate
 * was claimed by a different org), which retries with a fresh candidate.
 *
 * @throws when slug minting exhausts its retries — `isTaken` is broken;
 *   surfacing loudly beats a silently unslugged organization.
 */
export const insertOrganization = async (
  db: DrizzleDb,
  row: Pick<Organization, "id" | "name" | "workosUpdatedAt" | "deletedAt">,
): Promise<Organization> => {
  const slugTaken = async (slug: string) => {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    return rows.length > 0;
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = await generateOrgSlug(row.name, slugTaken);
    const [inserted] = await db
      .insert(organizations)
      .values({ ...row, slug })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // The insert was swallowed by a conflict. If the id now exists, a
    // concurrent writer mirrored it — return that row. Otherwise the slug
    // candidate collided; loop and mint a fresh one.
    const held = await readOrganization(db, row.id);
    if (held) return held;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: slug minting exhausted retries; surfacing loudly beats a silently unslugged org
  throw new Error(`unable to mint a slug for organization ${row.id}`);
};

export const makeUserStore = (db: DrizzleDb) => {
  const getOrganization = (id: string) => readOrganization(db, id);

  // Existing rows keep their slug (stable across renames, so org URLs
  // survive) and only refresh their name — and only from a payload at least
  // as new as the one that last named it (`organizationAcceptsName`): a
  // sign-in whose membership list was fetched before a rename would
  // otherwise revert the rename after it landed. A row marked deleted is
  // returned as it is: the organization is gone, and nothing a feeder still
  // holds about it (a name, a membership fetched before the deletion) is
  // written — never re-minted live, never renamed. A row the mirror does not
  // hold is minted live (`insertOrganization`).
  const upsertOrganization = async (org: OrganizationPayload) => {
    const existing = await getOrganization(org.id);
    if (existing) {
      if (existing.deletedAt !== null) return existing;
      const [updated] = await db
        .update(organizations)
        .set({ name: org.name, workosUpdatedAt: org.updatedAt })
        .where(and(eq(organizations.id, org.id), organizationAcceptsName(org.updatedAt)))
        .returning();
      return updated ?? existing;
    }
    return insertOrganization(db, {
      id: org.id,
      name: org.name,
      workosUpdatedAt: org.updatedAt,
      deletedAt: null,
    });
  };

  return {
    // --- Accounts ---

    ensureAccount: async (id: string) => {
      const [result] = await db.insert(accounts).values({ id }).onConflictDoNothing().returning();
      return result ?? (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!;
    },

    getAccount: async (id: string) => {
      const rows = await db.select().from(accounts).where(eq(accounts.id, id));
      return rows[0] ?? null;
    },

    // --- Organizations ---

    upsertOrganization,

    getOrganization,

    getOrganizationBySlug: async (slug: string) => {
      const rows = await db.select().from(organizations).where(eq(organizations.slug, slug));
      return rows[0] ?? null;
    },

    // Permanently delete everything an org owns (tenant data, secrets, its
    // memberships) in a single transaction, leaving the organization row as
    // a tombstone marked `deletedAt` (see `purgeOrganizationData` for why).
    // Callers sequence the external WorkOS/Autumn deletions around this.
    deleteOrganizationCascade: (id: string, deletedAt: Date) =>
      purgeOrganizationData(db, id, deletedAt),
  };
};
