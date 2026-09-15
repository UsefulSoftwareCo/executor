// ---------------------------------------------------------------------------
// The membership mirror's WRITE store — the Drizzle queries behind
// `WorkOsMirror`, plus the converters from WorkOS SDK payloads to mirror rows.
//
// Kept free of `cloudflare:workers` (no `DbService`, no `env`) so the one-off
// backfill (`scripts/backfill-workos-mirror.ts`) can run the SAME upserts over
// a plain postgres.js connection under bun. The request-scoped service that
// wraps this store is `workos-mirror.ts`.
//
// Every write is idempotent and out-of-order safe. Both upserts carry the
// WorkOS `updatedAt` of their payload and refuse to overwrite a row whose
// stored `workos_updated_at` is newer, so a replayed or late-arriving event
// can never regress the mirror. The cursor advances only by compare-and-set,
// so two reconciler runs cannot both own the stream.
// ---------------------------------------------------------------------------

import { and, eq, isNull, lte, or } from "drizzle-orm";
import { Effect } from "effect";

import type { MemberStatus } from "@executor-js/api/server";

import { accounts, memberships, workosSync } from "../db/schema";
import type { DrizzleDb } from "../db/db";
import {
  WorkOsMirrorError,
  tryPromiseService,
  userStoreReasonFromCause,
  withServiceLogging,
} from "./errors";

/** A WorkOS user, as the mirror stores it. `updatedAt` is WorkOS's own. */
export interface WorkOsMirrorUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly avatarUrl: string | null;
  readonly lastSignInAt: Date | null;
  readonly updatedAt: Date;
}

/**
 * A WorkOS organization membership, as the mirror stores it. `id` is the
 * WorkOS `om_…`; `accountId` the WorkOS user id; `updatedAt` is WorkOS's own.
 * The organization row must already be mirrored (`upsertOrganization`) — a
 * membership of an unknown org is a `query` failure, not a silent skip.
 */
export interface WorkOsMirrorMembership {
  readonly id: string;
  readonly accountId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly status: MemberStatus;
  readonly updatedAt: Date;
}

export interface WorkOsMirrorShape {
  /**
   * Insert or refresh a user row. `false` when the stored row is newer than
   * `updatedAt` (the payload was stale and left untouched).
   */
  readonly upsertUser: (user: WorkOsMirrorUser) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * Insert or refresh a membership row, minting the bare account row first so
   * the foreign key holds when the membership arrives before its user. `false`
   * when the stored row is newer than `updatedAt`.
   */
  readonly upsertMembership: (
    membership: WorkOsMirrorMembership,
  ) => Effect.Effect<boolean, WorkOsMirrorError>;
  /** Delete by WorkOS membership id. `false` when no row carried it. */
  readonly deleteMembership: (membershipId: string) => Effect.Effect<boolean, WorkOsMirrorError>;
  /** Delete an account (its memberships cascade). `false` when absent. */
  readonly deleteUser: (accountId: string) => Effect.Effect<boolean, WorkOsMirrorError>;
  /** The id of the last WorkOS event applied, or `null` before the first run. */
  readonly getCursor: () => Effect.Effect<string | null, WorkOsMirrorError>;
  /**
   * Compare-and-set the cursor: advance to `next` only if it still reads
   * `prev` (`null` = no cursor yet). `false` means another run moved it first
   * — the caller must stop, it no longer owns the stream.
   */
  readonly setCursor: (
    prev: string | null,
    next: string,
  ) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * When the one-off backfill (`scripts/backfill-workos-mirror.ts`) last
   * completed, or `null` if it never has. Until it has, the mirror holds only
   * what login and write-through have recorded since the mirror shipped, so
   * a count read from it is PARTIAL — the seat reporter refuses to push one
   * to billing. Migration 0019 seeds the marker on a database with no
   * organizations (nothing to backfill), so fresh dev/test databases report
   * from the start.
   */
  readonly backfillCompletedAt: () => Effect.Effect<Date | null, WorkOsMirrorError>;
  /** Record that the backfill completed now (idempotent). */
  readonly markBackfillComplete: () => Effect.Effect<void, WorkOsMirrorError>;
}

// ---------------------------------------------------------------------------
// SDK payload → mirror row. The feeders (login callback, write-through, the
// backfill, the Events reconciler) all hand the mirror WorkOS objects; this is
// the one place their field names and ISO timestamps are translated. Typed
// structurally (the fields actually read) so the SDK's `User` /
// `OrganizationMembership`, an event payload, and a test fixture all fit.
// ---------------------------------------------------------------------------

/** The WorkOS user fields the mirror reads. `User` from the SDK satisfies it. */
export interface WorkOsUserPayload {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly profilePictureUrl: string | null;
  readonly lastSignInAt: string | null;
  readonly updatedAt: string;
}

/**
 * The WorkOS membership fields the mirror reads. `OrganizationMembership` from
 * the SDK satisfies it; its `status` is exactly the mirror's `MemberStatus`.
 */
export interface WorkOsMembershipPayload {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: { readonly slug: string };
  readonly status: MemberStatus;
  readonly updatedAt: string;
}

/** Translate a WorkOS user payload to the row `upsertUser` stores. */
export const mirrorUserFromWorkOs = (user: WorkOsUserPayload): WorkOsMirrorUser => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  avatarUrl: user.profilePictureUrl,
  lastSignInAt: user.lastSignInAt === null ? null : new Date(user.lastSignInAt),
  updatedAt: new Date(user.updatedAt),
});

/** Translate a WorkOS membership payload to the row `upsertMembership` stores. */
export const mirrorMembershipFromWorkOs = (
  membership: WorkOsMembershipPayload,
): WorkOsMirrorMembership => ({
  id: membership.id,
  accountId: membership.userId,
  organizationId: membership.organizationId,
  role: membership.role.slug,
  status: membership.status,
  updatedAt: new Date(membership.updatedAt),
});

// The one events stream the reconciler follows. A row id rather than a
// singleton table so a second stream (another WorkOS environment, a replay)
// can be added without a schema change.
const EVENTS_CURSOR_ID = "events";
// The backfill-complete marker shares the table: `updated_at` is the
// completion time, `cursor` stays null. See `backfillCompletedAt`.
const BACKFILL_MARKER_ID = "backfill";

/**
 * The mirror's write operations over `db`. Failures are `WorkOsMirrorError`
 * naming the operation and the classified driver reason; the full cause is
 * logged at the boundary.
 */
export const makeWorkOsMirrorStore = (db: DrizzleDb): WorkOsMirrorShape => {
  const run = <A>(op: string, fn: () => Promise<A>) =>
    withServiceLogging(
      `workos_mirror.${op}`,
      (failure) =>
        new WorkOsMirrorError({
          operation: op,
          reason: userStoreReasonFromCause(failure),
        }),
      tryPromiseService(fn),
    );

  const ensureAccount = (id: string) =>
    db.insert(accounts).values({ id }).onConflictDoNothing({ target: accounts.id });

  return {
    upsertUser: (user) =>
      run("upsertUser", async () => {
        const written = await db
          .insert(accounts)
          .values({
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            avatarUrl: user.avatarUrl,
            lastSignInAt: user.lastSignInAt,
            workosUpdatedAt: user.updatedAt,
          })
          .onConflictDoUpdate({
            target: accounts.id,
            set: {
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              avatarUrl: user.avatarUrl,
              lastSignInAt: user.lastSignInAt,
              workosUpdatedAt: user.updatedAt,
            },
            // A row minted by `ensureAccount` has no timestamp and takes any
            // payload; otherwise only an equal-or-newer payload may write.
            setWhere: or(
              isNull(accounts.workosUpdatedAt),
              lte(accounts.workosUpdatedAt, user.updatedAt),
            ),
          })
          .returning({ id: accounts.id });
        return written.length > 0;
      }),

    upsertMembership: (membership) =>
      run("upsertMembership", async () => {
        await ensureAccount(membership.accountId);
        const written = await db
          .insert(memberships)
          .values({
            accountId: membership.accountId,
            organizationId: membership.organizationId,
            membershipId: membership.id,
            role: membership.role,
            status: membership.status,
            workosUpdatedAt: membership.updatedAt,
          })
          .onConflictDoUpdate({
            target: [memberships.accountId, memberships.organizationId],
            set: {
              membershipId: membership.id,
              role: membership.role,
              status: membership.status,
              workosUpdatedAt: membership.updatedAt,
            },
            setWhere: or(
              isNull(memberships.workosUpdatedAt),
              lte(memberships.workosUpdatedAt, membership.updatedAt),
            ),
          })
          .returning({ accountId: memberships.accountId });
        return written.length > 0;
      }),

    deleteMembership: (membershipId) =>
      run("deleteMembership", async () => {
        const deleted = await db
          .delete(memberships)
          .where(eq(memberships.membershipId, membershipId))
          .returning({ accountId: memberships.accountId });
        return deleted.length > 0;
      }),

    deleteUser: (accountId) =>
      run("deleteUser", async () => {
        const deleted = await db
          .delete(accounts)
          .where(eq(accounts.id, accountId))
          .returning({ id: accounts.id });
        return deleted.length > 0;
      }),

    getCursor: () =>
      run("getCursor", async () => {
        const rows = await db
          .select({ cursor: workosSync.cursor })
          .from(workosSync)
          .where(eq(workosSync.id, EVENTS_CURSOR_ID));
        // No row yet is the same state as a row with no cursor: nothing applied.
        return rows[0]?.cursor ?? null;
      }),

    setCursor: (prev, next) =>
      run("setCursor", async () => {
        const now = new Date();
        if (prev === null) {
          // First advance: mint the row, or claim an existing row that still
          // has no cursor. A row that already carries one belongs to another
          // run and is left alone.
          const written = await db
            .insert(workosSync)
            .values({ id: EVENTS_CURSOR_ID, cursor: next, updatedAt: now })
            .onConflictDoUpdate({
              target: workosSync.id,
              set: { cursor: next, updatedAt: now },
              setWhere: isNull(workosSync.cursor),
            })
            .returning({ id: workosSync.id });
          return written.length > 0;
        }
        const written = await db
          .update(workosSync)
          .set({ cursor: next, updatedAt: now })
          .where(and(eq(workosSync.id, EVENTS_CURSOR_ID), eq(workosSync.cursor, prev)))
          .returning({ id: workosSync.id });
        return written.length > 0;
      }),

    backfillCompletedAt: () =>
      run("backfillCompletedAt", async () => {
        const rows = await db
          .select({ updatedAt: workosSync.updatedAt })
          .from(workosSync)
          .where(eq(workosSync.id, BACKFILL_MARKER_ID));
        return rows[0]?.updatedAt ?? null;
      }),

    markBackfillComplete: () =>
      run("markBackfillComplete", async () => {
        const now = new Date();
        await db
          .insert(workosSync)
          .values({ id: BACKFILL_MARKER_ID, cursor: null, updatedAt: now })
          .onConflictDoUpdate({ target: workosSync.id, set: { updatedAt: now } });
      }),
  };
};
