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
// can never regress the mirror. A delete never drops the row: it TOMBSTONES
// it (`status = 'inactive'`, `deleted_at` set) — and INSERTS the tombstone
// when the row is not there yet — so a feeder that fetched the membership
// before the deletion and writes it after (a login, the backfill) finds the
// tombstone instead of reinstating access. The tombstone is protected by
// IDENTITY, not by time: WorkOS never reuses a deleted `om_…` id, so a
// payload naming the tombstoned id is refused whatever it is stamped — a
// role change issued before the removal and delivered after it is stamped
// NEWER than the row and would beat any timestamp guard — while a payload
// naming a DIFFERENT id for the same (account, organization) is the member
// re-added in WorkOS, a replacement, and takes the row over under the usual
// `updatedAt` rule (WorkOS creates it after the old one is deleted, so it is
// always the newer). A tombstone keeps the stamp the row holds, the deleted
// membership's last reported state — never a local clock: read after WorkOS
// answered, it could post-date a replacement created meanwhile and refuse
// it for good. `deleted_at` is the deletion instant when the caller holds
// one (an event's `createdAt`, a scan's listing time) and `now()` otherwise;
// it records WHEN, it orders nothing. A membership WorkOS merely
// deactivated (`status = 'inactive'`, no `deleted_at`) is not a tombstone:
// WorkOS can reactivate it under the same id, and the `updatedAt` rule
// orders that as any other update. The row tombstone can only speak for the
// id the row happens to hold, so every delete ALSO records the deleted id in
// `membership_tombstones`, a ledger keyed by the WorkOS id alone, and every
// membership write consults it first: that covers the case the row cannot —
// membership A replaced by B in WorkOS before the mirror saw either, B then
// deleted. The delete finds a row holding A (not B's to tombstone) and would
// otherwise leave nothing behind; a later scan that still lists B would then
// insert it live, stamped after A and under another id, exactly what the row
// guard lets through. With the ledger the delete is recorded whatever the
// row holds, and B's payload is refused by identity. A scan records the ids
// it tombstones the same way. A deleted USER is protected by identity
// too: `deleteUser` leaves the account row behind as a tombstone (profile
// cleared, stamped with the deletion), and no membership naming that account
// is written again, however the payload is stamped — WorkOS never reuses a
// user id, and a membership the mirror had not seen has no row of its own
// for a guard to refuse the insert against. The reconciler applies a page
// of events and advances the cursor in ONE transaction that
// compare-and-sets the cursor first (`applyPage`), so a run that has lost
// the stream to another run writes nothing — the `updatedAt` guard alone
// cannot stop it re-applying a page the leading run has moved past.
//
// A backfill SCAN of one organization (its full membership listing, taken
// at one instant) is applied the same way: ONE transaction that first
// compare-and-sets the organization's `backfilled_at` to the listing's
// instant (`applyOrganizationScan`), so the row stays locked until commit,
// two overlapping scans serialize on it, and the one whose listing is older
// than the recorded one writes NOTHING. The `updatedAt` guard alone cannot
// order two scans: a scan that listed a membership, stalled, and resumed
// after a later scan had found it gone would insert it live — the later scan
// left no tombstone, because the row was not there to tombstone. For the
// same reason every OTHER membership write is ordered against the scan too:
// a payload stamped before the organization's `backfilled_at` is refused
// unless the row already holds it — judged inside the write's own
// transaction, reading the organization row `FOR SHARE`, so a write that
// races a scan waits for the scan's commit and sees the mark it set, and
// never inserts a membership the scan has just proved revoked. A completed
// scan is the full listing as
// of that instant, so a membership it did not contain but an older payload
// still names (a login whose list was fetched before the revocation and
// written after the scan) was revoked before the scan — and that revocation
// predates the events replay boundary, so nothing would ever tombstone the
// reinstated row. The scan's own writes are the one exception: they are the
// listing that sets the mark.
//
// The events replay boundary (`workos_sync.range_start`) is written ONCE, by
// the first backfill run BEFORE its first listing, and never advanced: a
// scan refreshes memberships only, so an organization rename or user
// deletion after that instant — between two runs, or between a run that
// failed part-way and its retry — is covered by the events stream alone,
// and moving the boundary past it would skip it for good.
// ---------------------------------------------------------------------------

import { and, eq, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Data, Effect, Option } from "effect";

import type { MemberStatus } from "@executor-js/api/server";

import {
  accounts,
  membershipTombstones,
  memberships,
  organizations,
  workosSync,
} from "../db/schema";
import type { DrizzleDb } from "../db/db";
import { insertOrganization, organizationAcceptsName } from "./user-store";
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

/**
 * What identifies a membership to a delete: the WorkOS `om_…` id AND the
 * (account, organization) pair it belongs to. The pair is the row's key,
 * and a delete must be able to mint the row as a tombstone when the mirror
 * has not seen the membership yet — an id alone cannot.
 */
export type WorkOsMirrorMembershipRef = Pick<
  WorkOsMirrorMembership,
  "id" | "accountId" | "organizationId"
>;

/** One member as a backfill scan lists it: the membership and its user. */
export interface WorkOsScannedMember {
  readonly user: WorkOsMirrorUser;
  readonly membership: WorkOsMirrorMembership;
}

/**
 * One organization's full membership listing, as `applyOrganizationScan`
 * applies it. `listedAt` is the instant the listing was taken — BEFORE the
 * WorkOS read, so no change can fall between the instant and the listing —
 * and is the tombstone time for what the listing no longer contains, the
 * cut-off for what may be tombstoned at all, and the organization's new
 * `backfilled_at`.
 */
export interface WorkOsOrganizationScan {
  readonly organizationId: string;
  readonly listedAt: Date;
  readonly members: readonly WorkOsScannedMember[];
}

/** What an applied scan wrote: the upserts the `updatedAt` guard let through, and the tombstones. */
export interface WorkOsOrganizationScanWrites {
  readonly usersWritten: number;
  readonly membershipsWritten: number;
  readonly membershipsTombstoned: number;
}

/**
 * One write of a reconciler page, applied by `applyPage` inside the page's
 * transaction. The reconciler plans a page into these BEFORE the transaction
 * opens, so every WorkOS read (resolving an organization the mirror has never
 * seen) is done by then: the transaction holds the mirror's single connection
 * and must not wait on the network.
 */
export type WorkOsMirrorWrite = Data.TaggedEnum<{
  readonly UpsertUser: { readonly user: WorkOsMirrorUser };
  readonly UpsertMembership: { readonly membership: WorkOsMirrorMembership };
  /**
   * A membership together with its member's profile, read from WorkOS at
   * plan time because the mirror held no profile for the account
   * (`workos-events-sync.ts`): the user is upserted first, under the usual
   * guard, then the membership. The outcome is the membership's.
   */
  readonly UpsertMember: {
    readonly user: WorkOsMirrorUser;
    readonly membership: WorkOsMirrorMembership;
  };
  /** Tombstone a membership as of `deletedAt` (the event's `createdAt`). */
  readonly DeleteMembership: {
    readonly membership: WorkOsMirrorMembershipRef;
    readonly deletedAt: Date;
  };
  /** Tombstone a user and their memberships as of `deletedAt`. */
  readonly DeleteUser: { readonly accountId: string; readonly deletedAt: Date };
  /**
   * Rename an organization the mirror already holds — never inserts one —
   * from a payload stamped `updatedAt` (the WorkOS organization's own), under
   * the same name guard every feeder applies (`organizationAcceptsName`).
   */
  readonly RenameOrganization: {
    readonly organizationId: string;
    readonly name: string;
    readonly updatedAt: Date;
  };
  /**
   * Mark an organization deleted as of `deletedAt` (the event's
   * `createdAt`) — minting the row as a TOMBSTONE, named `name`, when the
   * mirror has never seen the organization, so a feeder still holding a
   * membership of it (a login that stalled across the deletion) finds the
   * tombstone and cannot mint the organization live. Never purges tenant
   * data (that is cloud's own flow, `db/org-deletion.ts`). An earlier mark
   * stands (`absent`).
   */
  readonly MarkOrganizationDeleted: {
    readonly organizationId: string;
    readonly name: string;
    readonly deletedAt: Date;
  };
}>;
export const WorkOsMirrorWrite = Data.taggedEnum<WorkOsMirrorWrite>();

/**
 * What one write did: a row was written, renamed, or tombstoned (`applied`);
 * the `updatedAt` guard refused an older payload (`stale`); or a delete found
 * its row already tombstoned or superseded by a newer membership (a
 * replayed delete), or a rename found no live organization row to change —
 * the mirror has never seen it, or it is marked deleted — or a deletion
 * mark found the organization already marked (`absent`).
 */
export type WorkOsMirrorWriteOutcome = "applied" | "stale" | "absent";

export interface WorkOsMirrorShape {
  /**
   * Insert or refresh a user row. `false` when the payload was refused and
   * the row left untouched: the stored row is newer than `updatedAt`, or is
   * a deletion tombstone stamped at `updatedAt` or later.
   */
  readonly upsertUser: (user: WorkOsMirrorUser) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * Insert or refresh a membership row, minting the bare account row first so
   * the foreign key holds when the membership arrives before its user. `false`
   * when the payload was refused: the stored row is newer than `updatedAt`,
   * or is a deletion tombstone of THIS membership id, or THIS membership id
   * is in the deletion ledger (`membership_tombstones`, written by every
   * delete and every scan tombstone, whatever row it found) — a deleted
   * WorkOS id never returns, however the payload is stamped; a payload under
   * another id is a replacement and is ordered by `updatedAt` against the
   * row's stamp — or the account is a deletion tombstone (`deleteUser`), whatever
   * the payload is stamped: WorkOS never reuses a user id, so a deleted user
   * has no memberships to mirror — or the organization is marked deleted
   * (`organizations.deleted_at`), in which case nothing is written at all:
   * no membership of a deleted organization is ever mirrored — or the
   * payload is stamped BEFORE the organization's last full scan
   * (`organizations.backfilled_at`): the scan listed everything WorkOS held
   * at that instant, so a membership it wrote already carries a stamp at
   * least this new (the write would change nothing) and one it did not
   * write was gone by then and must not come back from a list fetched
   * earlier. Only the scan itself writes past that mark
   * (`applyOrganizationScan`). The organization checks and the write run in
   * ONE transaction that holds the organization row `FOR SHARE`, so a scan
   * claiming the row at the same time is waited for and its mark seen — and
   * the account row `FOR SHARE` too, so a `deleteUser` tombstoning it at the
   * same time is waited for and its tombstone seen.
   */
  readonly upsertMembership: (
    membership: WorkOsMirrorMembership,
  ) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * Tombstone the membership as deleted: the row stays (or is minted, when
   * the mirror has not seen the membership yet), `inactive`, carrying the
   * deleted WorkOS id with `deleted_at` set. The tombstone is protected by
   * that id: `upsertMembership` refuses every later payload naming it,
   * however stamped, and accepts only a REPLACEMENT under another id. The
   * row's `workos_updated_at` is left as it is — the deleted membership's
   * last reported state, which a replacement is always stamped after; a
   * local clock read after WorkOS answered could post-date a replacement
   * created meanwhile and must never become the row's stamp. `deletedAt`
   * is the deletion instant when the caller holds one (a deletion event's
   * `createdAt`, a scan's listing time) or `null` when it holds none
   * (WorkOS answers a delete with no time): `deleted_at` then takes the
   * current time. It records when the membership was deleted; it orders
   * nothing. Matches the row by IDENTITY: `false` when the row is already
   * tombstoned (a replayed delete), or holds ANOTHER membership id — the
   * member re-added in WorkOS under a new id, which stands whether the
   * replacement was mirrored before or after this delete. In EVERY case the
   * deleted id is recorded in the deletion ledger (`membership_tombstones`),
   * so a membership the mirror never held under its own id (replaced and
   * deleted in WorkOS before the mirror saw it) cannot be inserted live by a
   * scan that listed it before the deletion: `true` when the row was
   * tombstoned OR the id was newly recorded. The organization row must
   * already be mirrored, as for `upsertMembership`.
   */
  readonly deleteMembership: (
    membership: WorkOsMirrorMembershipRef,
    deletedAt: Date | null,
  ) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * Tombstone a deleted WorkOS user: every membership of the account is
   * tombstoned as by `deleteMembership` (as of `deletedAt`; a deleted user's
   * membership ids never return), and the account row is kept (it anchors
   * foreign keys) — or minted, when the mirror has not seen the user yet —
   * with its profile cleared and stamped `deletedAt`, so a stale user
   * payload cannot restore it. `false` when the account already carries
   * this tombstone or a later one (a replayed delete). ONE transaction that
   * locks the account row first (`FOR NO KEY UPDATE`) and holds it until
   * the memberships are tombstoned: `upsertMembership` reads that row `FOR
   * SHARE` before it inserts, so a membership write racing the deletion
   * waits for it and sees the tombstone, or committed first and is
   * tombstoned here — never a live membership left behind for a deleted
   * user.
   */
  readonly deleteUser: (
    accountId: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, WorkOsMirrorError>;
  /** The id of the last WorkOS event applied, or `null` before the first run. */
  readonly getCursor: () => Effect.Effect<string | null, WorkOsMirrorError>;
  /**
   * Apply one reconciler page atomically: in a single transaction,
   * compare-and-set the cursor from `prev` (`null` = no cursor yet) to
   * `next`, and only if that succeeded apply `writes` in order. The cursor
   * row stays locked until commit, so two runs applying pages serialize on
   * it and the one whose `prev` is stale sees the moved cursor and writes
   * nothing: `None` means another run owns the stream and the caller must
   * stop. `Some` carries one outcome per write, in order. An empty `writes`
   * is a bare cursor advance.
   */
  readonly applyPage: (
    prev: string | null,
    next: string,
    writes: readonly WorkOsMirrorWrite[],
  ) => Effect.Effect<Option.Option<readonly WorkOsMirrorWriteOutcome[]>, WorkOsMirrorError>;
  /**
   * Apply one organization's backfill scan — the memberships (with their
   * users) a WorkOS listing taken at `listedAt` contained — atomically: in a
   * single transaction, compare-and-set the organization's `backfilled_at`
   * forward to `listedAt`, and only if that succeeded upsert every listed
   * user and membership and tombstone (as `deleteMembership` does, at
   * `listedAt`) every membership of the organization the listing did NOT
   * contain: the rows whose WorkOS id is not among the listed ones AND whose
   * stamp is older than the listing. A row stamped at or after `listedAt`
   * was written after the listing was taken (it could not be in it) and is
   * left alone — its own event lands through the reconciler; a tombstone
   * here would beat that event. Rows already tombstoned are left alone.
   *
   * The organization row stays locked until commit, so two overlapping
   * scans serialize on it and the one whose listing is older than (or the
   * same instant as) the recorded one writes nothing: `None` — the mirror
   * already holds the organization as of a later listing, and a membership
   * that listing no longer contained must not be inserted from this one.
   * `None` too for an organization the mirror does not hold or has marked
   * deleted: there is nothing to scan into. `Some` carries what was written.
   */
  readonly applyOrganizationScan: (
    scan: WorkOsOrganizationScan,
  ) => Effect.Effect<Option.Option<WorkOsOrganizationScanWrites>, WorkOsMirrorError>;
  /**
   * The Events API replay boundary: the instant the FIRST one-off backfill
   * run began reading WorkOS, or `null` if none has started. The
   * reconciler's first run (no cursor yet) reads the stream from here — the
   * backfill covers everything before it — and without a boundary it must
   * not guess.
   */
  readonly replayBoundary: () => Effect.Effect<Date | null, WorkOsMirrorError>;
  /**
   * Record the replay boundary, ONCE: `at` is the instant a backfill run
   * began reading WorkOS, and it is kept only when no boundary is recorded
   * yet — `true` when this call recorded it. A later run never moves it: the
   * backfill refreshes memberships and tombstones only, not organization
   * names or deleted users' profiles, so a change after the first boundary
   * is covered only by the events stream, which must still be read from
   * there. Written BEFORE the run's first listing, so a run that fails
   * part-way leaves the boundary standing and its retry keeps it — a
   * `user.deleted` between the attempts stays inside the replay. Never
   * touches the cursor: a stream already being followed keeps its position,
   * and the boundary is then unused.
   */
  readonly setReplayBoundary: (at: Date) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * When a backfill run first wrote EVERY live organization
   * (`workos_sync.backfill_completed_at`), or `null` while none has. The
   * first half of the mirror's READINESS for authorization: until a run has
   * covered every organization, the mirror may lack members who have not
   * signed in since it shipped, and a membership check read from it would
   * deny them. The other half is the events reconciler being caught up,
   * which its cursor row reports.
   */
  readonly backfillCompletedAt: () => Effect.Effect<Date | null, WorkOsMirrorError>;
  /**
   * Record that a backfill run has written every live organization, as of
   * `at` — ONCE: a later completed run keeps the first mark (`false`), so
   * readiness never flips back. Written only after the last organization
   * was applied (or refused in favour of a later listing), so a run that
   * fails part-way records nothing here. Mints the events row when absent,
   * as `setReplayBoundary` does, and touches neither the cursor nor the
   * boundary.
   */
  readonly markBackfillCompleted: (at: Date) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * When a reconciler run last read the events stream to its end
   * (`workos_sync.drained_at`), or `null` if none has. The second half of
   * the mirror's readiness for authorization: a mirror whose reconciler
   * has not caught up within the lag budget may still hold a membership
   * WorkOS has since revoked.
   */
  readonly drainedAt: () => Effect.Effect<Date | null, WorkOsMirrorError>;
  /**
   * Record that a reconciler run read the stream to its end at `at`. Moves
   * the mark forward only — a run that finished after a later one keeps the
   * later mark — and only on the row a run already owns: the events row is
   * minted by the boundary or the first cursor advance, so a missing row
   * means nothing was drained and nothing is written (`false`).
   */
  readonly markDrained: (at: Date) => Effect.Effect<boolean, WorkOsMirrorError>;
  /**
   * When the organization's membership list was last FULLY scanned from
   * WorkOS (`backfillOrganization` in workos-mirror-backfill.ts), or `null`
   * if it never was — or the organization is not mirrored. Until it has been,
   * the mirror may hold only the members login and write-through happened to
   * record, so a member count read from it is PARTIAL: every seat gate reads
   * this first and scans the organization when it is `null`. Per
   * organization, never database-wide, so an organization mirrored after a
   * backfill ran (lazily, or by a sign-in) is never mistaken for a scanned
   * one.
   */
  readonly organizationBackfilledAt: (
    organizationId: string,
  ) => Effect.Effect<Date | null, WorkOsMirrorError>;
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

/**
 * The `workos_sync` row of the one WorkOS events stream the reconciler
 * follows. A row id rather than a singleton table so a second stream
 * (another WorkOS environment, a replay) can be added without a schema
 * change; the same row carries the backfill's replay boundary and
 * completion mark. Not a `db/schema.ts` export: that module's exports are
 * enumerated as tables by the purge-coverage test.
 */
export const WORKOS_EVENTS_STREAM_ID = "events";

// A raw `sql` fragment binds a Date without the column's driver mapping, so
// every instant below is passed as ISO text and cast.
const instant = (at: Date) => sql`${at.toISOString()}::timestamptz`;

// An account tombstone moves the row's timestamp to the deletion time —
// never backwards, so a row that somehow carries a newer WorkOS timestamp
// keeps it and the upsert guard stays at least as strict.
const noEarlierThan = (column: AnyPgColumn, at: Date) => sql`greatest(${column}, ${instant(at)})`;

// A membership tombstone keeps the row, marks it `inactive`, and records the
// deletion in `deleted_at`: the instant the caller holds, or `now()` when it
// holds none (see `deleteMembership`). `workos_updated_at` is left as it is
// — the tombstone is protected by the deleted id, not by its stamp.
const tombstone = (deletedAt: Date | null) => ({
  status: "inactive" as const,
  deletedAt: deletedAt === null ? sql`now()` : instant(deletedAt),
});

// Which stored membership rows a payload for membership `id` stamped
// `updatedAt` may overwrite. A row WorkOS still holds (`deleted_at` null) is
// ordered by time: a row with no stamp (predating the mirror), any row
// stamped earlier, and a LIVE row stamped the same instant — feeders replay
// the same payload and must converge, not stall. An `inactive` row stamped
// the same instant is not overwritten: a deactivation at T beats an active
// payload at T. A deletion tombstone is ordered by IDENTITY: never
// overwritten by a payload naming the deleted id — a deleted WorkOS
// membership id never returns, however the payload is stamped — and taken
// over by a payload naming another id, a replacement membership WorkOS
// created after the deletion and so stamped after the row's last state,
// under the plain timestamp rule. A tombstone with no id at all (a
// pre-mirror row of a deleted user) is never taken over: the user is gone.
const membershipAcceptsPayload = (id: string, updatedAt: Date) =>
  or(
    and(
      isNull(memberships.deletedAt),
      or(
        isNull(memberships.workosUpdatedAt),
        lt(memberships.workosUpdatedAt, updatedAt),
        and(eq(memberships.workosUpdatedAt, updatedAt), ne(memberships.status, "inactive")),
      ),
    ),
    and(
      isNotNull(memberships.deletedAt),
      ne(memberships.membershipId, id),
      or(isNull(memberships.workosUpdatedAt), lt(memberships.workosUpdatedAt, updatedAt)),
    ),
  );

// A deleted user's account row, as `deleteUser` leaves it: the profile is
// cleared (every WorkOS user payload carries an email, so a stamped row with
// none was written by `deleteUser`) and the stamp is the deletion time. A row
// minted bare by `ensureAccount` has no stamp either, and is not a tombstone.
// Judged in code, over a row read under a lock (`writeMembership`), not as a
// predicate in the read: a `SELECT ... FOR SHARE` locks only the rows it
// returns, so a read filtered to tombstones would lock nothing for a live
// row — the one case the lock exists for.
const isAccountTombstone = (account: {
  readonly email: string | null;
  readonly workosUpdatedAt: Date | null;
}): boolean => account.email === null && account.workosUpdatedAt !== null;

// The same rule as for a membership row, for an account row. A tombstone
// takes no payload stamped at or before the deletion; a bare row takes any.
const accountAcceptsPayload = (updatedAt: Date) =>
  or(
    isNull(accounts.workosUpdatedAt),
    lt(accounts.workosUpdatedAt, updatedAt),
    and(eq(accounts.workosUpdatedAt, updatedAt), isNotNull(accounts.email)),
  );

// A delete is applied only to a row not yet tombstoned: a replayed deletion
// changes nothing and reports so.
const notDeleted = isNull(memberships.deletedAt);

// Whether membership `id` is in the deletion ledger: a WorkOS id a delete or
// a scan has named as gone, which never returns. Identity alone — the
// ledger records WHEN for the record, not for ordering.
const membershipIdDeleted = async (db: DrizzleDb, id: string): Promise<boolean> => {
  const rows = await db
    .select({ membershipId: membershipTombstones.membershipId })
    .from(membershipTombstones)
    .where(eq(membershipTombstones.membershipId, id));
  return rows.length > 0;
};

// Which (account, organization) row a delete of membership `id` may
// tombstone: the row carrying THIS id — whatever its stamp, a deleted id is
// never reused — or a row with no id at all (written before the mirror
// recorded WorkOS ids; the delete fills the id in). Never a row under
// ANOTHER id: that is a different membership of the same account and
// organization, the member re-added in WorkOS after this one was removed,
// and it stands however the two are stamped. Identity orders them,
// timestamps do not. A row already tombstoned is left alone (`notDeleted`)
// so a replayed delete reports `false`.
const membershipDeletableBy = (id: string) =>
  and(or(isNull(memberships.membershipId), eq(memberships.membershipId, id)), notDeleted);

// The write queries, over `db` or over a transaction handle (drizzle's is a
// `PgDatabase` too): the one `applyPage` or `applyOrganizationScan` opens,
// or the one the store opens per `upsertMembership`. Each answers whether
// it wrote a row; the public shape and the transactions translate that.
const makeWrites = (db: DrizzleDb) => {
  const ensureAccount = (id: string) =>
    db.insert(accounts).values({ id }).onConflictDoNothing({ target: accounts.id });

  // The membership upsert under the row guard (`membershipAcceptsPayload`)
  // and the account tombstone, never the organization mark.
  const writeMembership = async (membership: WorkOsMirrorMembership): Promise<boolean> => {
    await ensureAccount(membership.accountId);
    // Never for a DELETED user. The row guard below orders a payload against
    // the membership row it would overwrite; a membership the mirror has not
    // seen yet has no row, so the guard cannot refuse the INSERT — and a
    // feeder that fetched the membership before the user was deleted and
    // writes it after (a stalled login list, the backfill's older listing)
    // would insert it live. The account tombstone is the one row a deleted
    // user always leaves behind, so it is consulted first, by identity:
    // WorkOS never reuses a user id, so no payload naming a tombstoned
    // account is ever current.
    //
    // Read FOR SHARE, held until the transaction `db` belongs to commits: a
    // `deleteUser` applying the deletion at this moment holds the row FOR NO
    // KEY UPDATE until ITS commit, so this read waits for it and sees the
    // tombstone — and a deletion that arrives after this read waits for this
    // transaction, then tombstones the membership it inserted. Unlocked, a
    // deletion could land between this read and the insert below and leave
    // a live membership for a deleted user.
    const locked = await db
      .select({ email: accounts.email, workosUpdatedAt: accounts.workosUpdatedAt })
      .from(accounts)
      .where(eq(accounts.id, membership.accountId))
      .for("share");
    const account = locked[0];
    // `ensureAccount` guarantees the row; accounts are tombstoned, never
    // deleted, so a missing one is refused like a tombstone, not written for.
    if (account === undefined || isAccountTombstone(account)) return false;
    // Never under a DELETED membership id. The row guard below can only
    // refuse against the id the row holds; a delete of THIS id that found
    // the row under another id (see the header) left only the ledger entry
    // behind, and that is what refuses the payload here.
    if (await membershipIdDeleted(db, membership.id)) return false;
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
          // A replacement taking over a tombstone is live again; a row that
          // was not tombstoned had nothing here.
          deletedAt: null,
        },
        setWhere: membershipAcceptsPayload(membership.id, membership.updatedAt),
      })
      .returning({ accountId: memberships.accountId });
    return written.length > 0;
  };

  return {
    upsertUser: async (user: WorkOsMirrorUser): Promise<boolean> => {
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
          setWhere: accountAcceptsPayload(user.updatedAt),
        })
        .returning({ id: accounts.id });
      return written.length > 0;
    },

    upsertMembership: async (membership: WorkOsMirrorMembership): Promise<boolean> => {
      // Never into an organization the mirror holds as DELETED: its
      // memberships are gone from WorkOS and purged (or being purged) here,
      // so a payload that still names it was fetched before the deletion —
      // a login that stalled across the purge, a stale event — and writing
      // it would grant access to a deleted organization. The tombstone row
      // outlives the purge for exactly this check. And never from a payload
      // stamped before the organization's last full scan: the scan is the
      // complete listing as of `backfilled_at`, so an older payload either
      // repeats a row the scan wrote (nothing to change) or names a
      // membership the scan found gone — revoked before the mirror's events
      // replay begins, so no event would ever tombstone it again. The row
      // is read FOR SHARE, so a scan claiming it at this moment
      // (`claimOrganizationScan`, an UPDATE that holds the row until its
      // transaction commits) and the purge marking it deleted are waited
      // for, and the mark read is the committed one: a scan cannot slip
      // between this read and the write below and leave a membership it
      // proved revoked inserted after it. The lock is held until the
      // transaction `db` belongs to ends — `makeWorkOsMirrorStore` opens one
      // per call, `applyPage` runs this on the page's own — which is what
      // orders the write after the scan. An organization the mirror does
      // not hold at all is still a foreign-key failure in the write.
      const organization = await db
        .select({
          deletedAt: organizations.deletedAt,
          backfilledAt: organizations.backfilledAt,
        })
        .from(organizations)
        .where(eq(organizations.id, membership.organizationId))
        .for("share");
      const row = organization[0];
      if (row?.deletedAt != null) return false;
      if (row?.backfilledAt != null && membership.updatedAt < row.backfilledAt) return false;
      return writeMembership(membership);
    },

    // A scan's own membership writes: the scan has just claimed the
    // organization as of its listing, so its payloads are exactly what the
    // mark stands for and are not ordered against it.
    writeScannedMembership: writeMembership,

    // An upsert, like the membership write it guards against: a delete the
    // mirror sees before the membership itself (the reconciler ahead of the
    // backfill) must leave the tombstone behind, or the later, older payload
    // would insert the row live.
    deleteMembership: async (
      membership: WorkOsMirrorMembershipRef,
      deletedAt: Date | null,
    ): Promise<boolean> => {
      await ensureAccount(membership.accountId);
      // Lock the account row FOR NO KEY UPDATE, as `deleteUser` does: a
      // membership write of this user reads the row FOR SHARE before it
      // consults the ledger (`writeMembership`), so a write racing this
      // delete either waits here and then finds the ledger entry, or
      // committed first and is tombstoned by the row upsert below. Without
      // the lock a write could pass the ledger check before this entry
      // lands and insert the deleted membership live after it.
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, membership.accountId))
        .for("no key update");
      // The ledger entry FIRST, whatever the row holds: the one record of
      // the deletion that does not depend on the row carrying the deleted
      // id. A replayed delete finds it there and records nothing new.
      const recorded = await db
        .insert(membershipTombstones)
        .values({
          membershipId: membership.id,
          accountId: membership.accountId,
          organizationId: membership.organizationId,
          ...(deletedAt === null ? {} : { deletedAt }),
        })
        .onConflictDoNothing({ target: membershipTombstones.membershipId })
        .returning({ membershipId: membershipTombstones.membershipId });
      const tombstoned = await db
        .insert(memberships)
        .values({
          accountId: membership.accountId,
          organizationId: membership.organizationId,
          membershipId: membership.id,
          ...tombstone(deletedAt),
        })
        .onConflictDoUpdate({
          target: [memberships.accountId, memberships.organizationId],
          set: { membershipId: membership.id, ...tombstone(deletedAt) },
          setWhere: membershipDeletableBy(membership.id),
        })
        .returning({ accountId: memberships.accountId });
      return recorded.length > 0 || tombstoned.length > 0;
    },

    // Only inside a transaction: the account row lock taken first is what
    // orders this against a membership write of the same user, and it lasts
    // exactly as long as the transaction `db` belongs to — the one the store
    // opens per call.
    deleteUser: async (accountId: string, deletedAt: Date): Promise<boolean> => {
      // Lock the account row FIRST — minted bare when absent, so there is a
      // row to lock (the tombstone is minted for the same reason as the
      // membership one: a later, older payload must find it) — and hold it
      // FOR NO KEY UPDATE until commit. A membership write reads the row FOR
      // SHARE before it inserts (`writeMembership`), so a write racing this
      // delete either waits here and then sees the tombstone, or committed
      // before this lock was granted and is caught by the membership
      // tombstoning below. Without the lock a write could read the row live
      // and insert its membership after the tombstoning had run.
      await ensureAccount(accountId);
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .for("no key update");
      // The account tombstone: profile cleared, stamped with the deletion.
      // Applied unless the row already carries this tombstone or a later one
      // (a replayed delete).
      const cleared = await db
        .update(accounts)
        .set({
          email: null,
          firstName: null,
          lastName: null,
          avatarUrl: null,
          workosUpdatedAt: noEarlierThan(accounts.workosUpdatedAt, deletedAt),
        })
        .where(
          and(
            eq(accounts.id, accountId),
            or(
              isNotNull(accounts.email),
              isNull(accounts.workosUpdatedAt),
              lt(accounts.workosUpdatedAt, deletedAt),
            ),
          ),
        )
        .returning({ id: accounts.id });
      await db
        .update(memberships)
        .set(tombstone(deletedAt))
        .where(and(eq(memberships.accountId, accountId), notDeleted));
      return cleared.length > 0;
    },

    // An UPDATE, never an insert: the slug is minted only by
    // `upsertOrganization` (auth/user-store.ts), and an org purged by cloud's
    // own deletion flow must not come back — with a fresh slug and no members
    // — because a rename that preceded the deletion is replayed after it.
    // Only of a LIVE row, and only from a payload at least as new as the one
    // that last named it: the same guard `upsertOrganization` applies, so
    // an event rename and a sign-in's name (stamped by its fetch) order
    // each other however they arrive.
    renameOrganization: async (
      organizationId: string,
      name: string,
      updatedAt: Date,
    ): Promise<WorkOsMirrorWriteOutcome> => {
      const renamed = await db
        .update(organizations)
        .set({ name, workosUpdatedAt: updatedAt })
        .where(
          and(
            eq(organizations.id, organizationId),
            isNull(organizations.deletedAt),
            organizationAcceptsName(updatedAt),
          ),
        )
        .returning({ id: organizations.id });
      if (renamed.length > 0) return "applied";
      // Refused: tell a live row the guard held back (`stale`) from a row
      // the mirror does not hold or holds as deleted (`absent`).
      const live = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)));
      return live.length > 0 ? "stale" : "absent";
    },

    // Marks a live row, or MINTS a tombstone row when the mirror has never
    // seen the organization: an org created, populated, and deleted in the
    // WorkOS dashboard before anyone signed in leaves no row behind
    // otherwise, and a login that fetched its memberships before the
    // deletion (and stalled) would then mint the org live, with nothing
    // left in the stream to revoke it — this event is consumed. A row
    // already marked is left alone: cloud's own deletion flow marks the org
    // before deleting it in WorkOS, so the event that follows finds the
    // mark already there and changes nothing — `false`, as for a replayed
    // event. Minted through the one slug mint point (`insertOrganization`),
    // so a tombstone is a routable, unique-slugged row like any other; the
    // mark alone is what refuses it.
    markOrganizationDeleted: async (
      organizationId: string,
      name: string,
      deletedAt: Date,
    ): Promise<boolean> => {
      const mark = async () => {
        const marked = await db
          .update(organizations)
          .set({ deletedAt })
          .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
          .returning({ id: organizations.id });
        return marked.length > 0;
      };
      if (await mark()) return true;
      const held = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      if (held.length > 0) return false;
      const minted = await insertOrganization(db, {
        id: organizationId,
        name,
        workosUpdatedAt: null,
        deletedAt,
      });
      // A concurrent feeder may have minted the row LIVE between the read
      // and the insert (the insert then yields its row): mark that one.
      return minted.deletedAt !== null || mark();
    },

    // Tombstone (at `listedAt`) every membership of the organization that a
    // listing taken at `listedAt` did not contain. Only inside a scan's
    // transaction, after its `backfilled_at` CAS: on its own this could
    // tombstone what a LATER scan just wrote.
    tombstoneMembershipsExcept: async (
      organizationId: string,
      membershipIds: readonly string[],
      listedAt: Date,
    ): Promise<number> => {
      const tombstoned = await db
        .update(memberships)
        .set(tombstone(listedAt))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            // A row with no WorkOS id predates the mirror and is not in
            // any listing; if WorkOS still holds the membership, the
            // scan's upsert has just filled the id in.
            or(
              isNull(memberships.membershipId),
              notInArray(memberships.membershipId, [...membershipIds]),
            ),
            // Only rows the listing could have contained: stamped before
            // it was taken (or never stamped). Anything newer was written
            // after the listing and is not missing from it.
            or(isNull(memberships.workosUpdatedAt), lt(memberships.workosUpdatedAt, listedAt)),
            notDeleted,
          ),
        )
        .returning({
          accountId: memberships.accountId,
          membershipId: memberships.membershipId,
        });
      // The ids the listing proved gone go into the ledger too, as any other
      // delete's: they never return. A row with no id has none to record.
      const gone = tombstoned.flatMap((row) =>
        row.membershipId === null
          ? []
          : [
              {
                membershipId: row.membershipId,
                accountId: row.accountId,
                organizationId,
                deletedAt: listedAt,
              },
            ],
      );
      if (gone.length > 0) {
        await db
          .insert(membershipTombstones)
          .values(gone)
          .onConflictDoNothing({ target: membershipTombstones.membershipId });
      }
      return tombstoned.length;
    },
  };
};

type Writes = ReturnType<typeof makeWrites>;

const applyWrite = (writes: Writes, write: WorkOsMirrorWrite): Promise<WorkOsMirrorWriteOutcome> =>
  WorkOsMirrorWrite.$match(write, {
    UpsertUser: async ({ user }) => ((await writes.upsertUser(user)) ? "applied" : "stale"),
    UpsertMembership: async ({ membership }) =>
      (await writes.upsertMembership(membership)) ? "applied" : "stale",
    UpsertMember: async ({ user, membership }) => {
      await writes.upsertUser(user);
      return (await writes.upsertMembership(membership)) ? "applied" : "stale";
    },
    DeleteMembership: async ({ membership, deletedAt }) =>
      (await writes.deleteMembership(membership, deletedAt)) ? "applied" : "absent",
    DeleteUser: async ({ accountId, deletedAt }) =>
      (await writes.deleteUser(accountId, deletedAt)) ? "applied" : "absent",
    RenameOrganization: ({ organizationId, name, updatedAt }) =>
      writes.renameOrganization(organizationId, name, updatedAt),
    MarkOrganizationDeleted: async ({ organizationId, name, deletedAt }) =>
      (await writes.markOrganizationDeleted(organizationId, name, deletedAt))
        ? "applied"
        : "absent",
  });

// Compare-and-set the events cursor. Run inside a transaction this also
// LOCKS the cursor row until commit: a concurrent run's CAS waits here, then
// re-reads the moved cursor and matches nothing.
const advanceCursor = async (db: DrizzleDb, prev: string | null, next: string) => {
  const now = new Date();
  if (prev === null) {
    // First advance: mint the row, or claim an existing row that still has
    // no cursor. A row that already carries one belongs to another run and
    // is left alone.
    const written = await db
      .insert(workosSync)
      .values({ id: WORKOS_EVENTS_STREAM_ID, cursor: next, updatedAt: now })
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
    .where(and(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID), eq(workosSync.cursor, prev)))
    .returning({ id: workosSync.id });
  return written.length > 0;
};

// Claim the organization for a scan listed at `listedAt`: move its
// `backfilled_at` forward to `listedAt` if the recorded mark is older (or
// missing). Run inside a transaction this also LOCKS the organization row
// until commit, so an overlapping scan's claim waits here, then reads the
// moved mark and matches nothing. An organization marked deleted is never
// claimed: its memberships are being (or have been) purged, and a scan
// that listed them before the deletion must not write them back.
const claimOrganizationScan = async (db: DrizzleDb, organizationId: string, listedAt: Date) => {
  const claimed = await db
    .update(organizations)
    .set({ backfilledAt: listedAt })
    .where(
      and(
        eq(organizations.id, organizationId),
        isNull(organizations.deletedAt),
        or(isNull(organizations.backfilledAt), lt(organizations.backfilledAt, listedAt)),
      ),
    )
    .returning({ id: organizations.id });
  return claimed.length > 0;
};

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

  const writes = makeWrites(db);

  return {
    upsertUser: (user) => run("upsertUser", () => writes.upsertUser(user)),

    // One transaction per call: the organization guard inside locks the org
    // row until the write has landed (see `makeWrites`).
    upsertMembership: (membership) =>
      run("upsertMembership", () =>
        db.transaction((tx) => makeWrites(tx).upsertMembership(membership)),
      ),

    // One transaction per call: the ledger entry and the row tombstone land
    // together or not at all.
    deleteMembership: (membership, deletedAt) =>
      run("deleteMembership", () =>
        db.transaction((tx) => makeWrites(tx).deleteMembership(membership, deletedAt)),
      ),

    // One transaction per call: the account row lock inside is held until
    // the memberships are tombstoned (see `makeWrites`).
    deleteUser: (accountId, deletedAt) =>
      run("deleteUser", () =>
        db.transaction((tx) => makeWrites(tx).deleteUser(accountId, deletedAt)),
      ),

    getCursor: () =>
      run("getCursor", async () => {
        const rows = await db
          .select({ cursor: workosSync.cursor })
          .from(workosSync)
          .where(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID));
        // No row yet is the same state as a row with no cursor: nothing applied.
        return rows[0]?.cursor ?? null;
      }),

    applyPage: (prev, next, pageWrites) =>
      run("applyPage", () =>
        db.transaction(async (tx) => {
          // The CAS comes FIRST so the lock is held for every write below;
          // a run that lost the stream commits an empty transaction.
          const owned = await advanceCursor(tx, prev, next);
          if (!owned) return Option.none();
          const txWrites = makeWrites(tx);
          const outcomes: WorkOsMirrorWriteOutcome[] = [];
          for (const write of pageWrites) {
            outcomes.push(await applyWrite(txWrites, write));
          }
          return Option.some<readonly WorkOsMirrorWriteOutcome[]>(outcomes);
        }),
      ),

    applyOrganizationScan: (scan) =>
      run("applyOrganizationScan", () =>
        db.transaction(async (tx) => {
          // The claim comes FIRST so the lock is held for every write below;
          // a scan that lost to a later listing commits an empty transaction.
          const claimed = await claimOrganizationScan(tx, scan.organizationId, scan.listedAt);
          if (!claimed) return Option.none();
          const txWrites = makeWrites(tx);
          let usersWritten = 0;
          let membershipsWritten = 0;
          for (const member of scan.members) {
            if (await txWrites.upsertUser(member.user)) usersWritten += 1;
            if (await txWrites.writeScannedMembership(member.membership)) membershipsWritten += 1;
          }
          const membershipsTombstoned = await txWrites.tombstoneMembershipsExcept(
            scan.organizationId,
            scan.members.map((member) => member.membership.id),
            scan.listedAt,
          );
          const written: WorkOsOrganizationScanWrites = {
            usersWritten,
            membershipsWritten,
            membershipsTombstoned,
          };
          return Option.some(written);
        }),
      ),

    replayBoundary: () =>
      run("replayBoundary", async () => {
        const rows = await db
          .select({ rangeStart: workosSync.rangeStart })
          .from(workosSync)
          .where(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID));
        return rows[0]?.rangeStart ?? null;
      }),

    setReplayBoundary: (at) =>
      run("setReplayBoundary", async () => {
        const recorded = await db
          .insert(workosSync)
          .values({
            id: WORKOS_EVENTS_STREAM_ID,
            cursor: null,
            rangeStart: at,
            updatedAt: at,
          })
          .onConflictDoUpdate({
            target: workosSync.id,
            set: { rangeStart: at },
            // A boundary already recorded stands, whatever this run's is.
            setWhere: isNull(workosSync.rangeStart),
          })
          .returning({ id: workosSync.id });
        return recorded.length > 0;
      }),

    backfillCompletedAt: () =>
      run("backfillCompletedAt", async () => {
        const rows = await db
          .select({ backfillCompletedAt: workosSync.backfillCompletedAt })
          .from(workosSync)
          .where(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID));
        return rows[0]?.backfillCompletedAt ?? null;
      }),

    markBackfillCompleted: (at) =>
      run("markBackfillCompleted", async () => {
        const recorded = await db
          .insert(workosSync)
          .values({
            id: WORKOS_EVENTS_STREAM_ID,
            cursor: null,
            backfillCompletedAt: at,
            updatedAt: at,
          })
          .onConflictDoUpdate({
            target: workosSync.id,
            set: { backfillCompletedAt: at },
            // The first completion stands, whatever this run's is.
            setWhere: isNull(workosSync.backfillCompletedAt),
          })
          .returning({ id: workosSync.id });
        return recorded.length > 0;
      }),

    drainedAt: () =>
      run("drainedAt", async () => {
        const rows = await db
          .select({ drainedAt: workosSync.drainedAt })
          .from(workosSync)
          .where(eq(workosSync.id, WORKOS_EVENTS_STREAM_ID));
        return rows[0]?.drainedAt ?? null;
      }),

    markDrained: (at) =>
      run("markDrained", async () => {
        const moved = await db
          .update(workosSync)
          .set({ drainedAt: at })
          .where(
            and(
              eq(workosSync.id, WORKOS_EVENTS_STREAM_ID),
              or(isNull(workosSync.drainedAt), lt(workosSync.drainedAt, at)),
            ),
          )
          .returning({ id: workosSync.id });
        return moved.length > 0;
      }),

    organizationBackfilledAt: (organizationId) =>
      run("organizationBackfilledAt", async () => {
        const rows = await db
          .select({ backfilledAt: organizations.backfilledAt })
          .from(organizations)
          .where(eq(organizations.id, organizationId));
        return rows[0]?.backfilledAt ?? null;
      }),
  };
};
