// ---------------------------------------------------------------------------
// WorkOsMirror — the WRITE side of cloud's local membership mirror.
//
// WorkOS owns users and organization memberships. This service keeps the
// `accounts` / `memberships` rows (db/schema.ts) in step with it so the read
// side (`auth/member-directory.ts`, the cloud `MemberDirectory`) never has to
// ask WorkOS. Three feeders write through it: the login callback (user +
// memberships already in hand), Executor-initiated changes (write-through),
// and the WorkOS Events API reconciler (dashboard-side changes, replayed in
// order from a persisted cursor).
//
// Every write is idempotent and out-of-order safe. Both upserts carry the
// WorkOS `updatedAt` of their payload and refuse to overwrite a row whose
// stored `workos_updated_at` is newer, so a replayed or late-arriving event
// can never regress the mirror. The cursor advances only by compare-and-set,
// so two reconciler runs cannot both own the stream.
//
// Per-request layer shape, like `UserStoreService`: it holds the request's
// postgres socket, so it is rebuilt per request (`RequestScopedServicesLive`)
// and never shared across Workers requests.
// ---------------------------------------------------------------------------

import { and, eq, isNull, lte, or } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { type MemberStatus } from "@executor-js/api/server";

import { accounts, memberships, workosSync } from "../db/schema";
import { DbService, type DrizzleDb } from "../db/db";
import {
  USER_STORE_FAILURE_REASONS,
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

/**
 * The public failure of every mirror write: which call, and how it failed
 * (classified from the driver cause the same way `UserStoreError` is).
 */
export class WorkOsMirrorError extends Schema.TaggedErrorClass<WorkOsMirrorError>()(
  "WorkOsMirrorError",
  {
    operation: Schema.String,
    reason: Schema.Literals(USER_STORE_FAILURE_REASONS),
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `workos mirror ${this.operation} failed: ${this.reason}`;
  }
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
}

// The one events stream the reconciler follows. A row id rather than a
// singleton table so a second stream (another WorkOS environment, a replay)
// can be added without a schema change.
const EVENTS_CURSOR_ID = "events";

const makeService = (db: DrizzleDb): WorkOsMirrorShape => {
  const run = <A>(op: string, fn: () => Promise<A>) =>
    withServiceLogging(
      `workos_mirror.${op}`,
      (failure) =>
        new WorkOsMirrorError({ operation: op, reason: userStoreReasonFromCause(failure) }),
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
  };
};

export class WorkOsMirror extends Context.Service<WorkOsMirror, WorkOsMirrorShape>()(
  "@executor-js/cloud/WorkOsMirror",
) {
  static Live = Layer.effect(this)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));
}

/**
 * A FRESH `WorkOsMirror` layer (new layer value per call), for a service built
 * once but invoked across many Workers requests — the same reason
 * `makeUserStoreLayer` exists. See [[makeDbLayer]].
 */
export const makeWorkOsMirrorLayer = (): Layer.Layer<WorkOsMirror, never, DbService> =>
  Layer.effect(WorkOsMirror)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));
