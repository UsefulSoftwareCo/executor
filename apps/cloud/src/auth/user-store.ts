// ---------------------------------------------------------------------------
// Account & Organization storage — minimal mirror of WorkOS data
// ---------------------------------------------------------------------------
//
// AuthKit owns the canonical data for users, organizations, memberships,
// and invitations. We keep tiny local mirrors of accounts and organizations
// so domain tables can foreign-key against them and so we can resolve org
// metadata without an API call on every request.

import { eq } from "drizzle-orm";

import { generateOrgSlug } from "@executor-js/api";

import { accounts, organizations } from "../db/schema";
import type { DrizzleDb } from "../db/db";

export type Account = typeof accounts.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

export const makeUserStore = (db: DrizzleDb) => {
  const getOrganization = async (id: string) => {
    const rows = await db.select().from(organizations).where(eq(organizations.id, id));
    return rows[0] ?? null;
  };

  const slugTaken = async (slug: string) => {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    return rows.length > 0;
  };

  // Insert a brand-new org row carrying a freshly-minted slug. `ON CONFLICT DO
  // NOTHING` (no target) absorbs BOTH unique violations without throwing: an
  // id collision (the org was mirrored concurrently) and a slug collision (the
  // candidate was claimed by a different org). Returns the inserted row, or
  // null when either conflict swallowed the insert — the caller decides whether
  // to re-read (id race) or retry with a new candidate (slug race).
  const tryInsertOrg = async (id: string, name: string, slug: string) => {
    const [row] = await db
      .insert(organizations)
      .values({ id, name, slug })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  };

  // Every new org row is born with a slug — there is no nullable window and no
  // self-healing. Existing rows keep their slug (stable across renames, so org
  // URLs survive) and only refresh their name.
  const upsertOrganization = async (org: { id: string; name: string }) => {
    const existing = await getOrganization(org.id);
    if (existing) {
      const [updated] = await db
        .update(organizations)
        .set({ name: org.name })
        .where(eq(organizations.id, org.id))
        .returning();
      return updated ?? existing;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const slug = await generateOrgSlug(org.name, slugTaken);
      const inserted = await tryInsertOrg(org.id, org.name, slug);
      if (inserted) return inserted;
      // The insert was swallowed by a conflict. If the id now exists, a
      // concurrent request mirrored it — return that row. Otherwise the slug
      // candidate collided; loop and mint a fresh one.
      const fresh = await getOrganization(org.id);
      if (fresh) return fresh;
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: slug minting exhausted retries; surfacing loudly beats a silently unslugged org
    throw new Error(`unable to mint a slug for organization ${org.id}`);
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
  };
};
