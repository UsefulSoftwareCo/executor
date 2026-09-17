// ---------------------------------------------------------------------------
// Backfill of the membership mirror from WorkOS, one organization at a time:
// list EVERY membership WorkOS holds for it — active, pending, and inactive
// alike — fetch each member's user, write both through the mirror's guarded
// upserts, tombstone whatever the mirror still holds that WorkOS no longer
// lists, and mark the organization BACKFILLED as of the listing. Inactive
// memberships are listed on purpose: the scan tombstones every mirrored
// membership its listing lacks, and a tombstone is keyed to the membership
// id for good (`membershipAcceptsPayload`), so a listing that skipped the
// inactive ones would tombstone a membership WorkOS merely deactivated and
// refuse its reactivation — under the same id — forever. Listed with its
// real status it stays an ordinary `inactive` row that a newer payload
// reactivates. The core is a pure function over a `source`
// (WorkOS reads) and the mirror store, so the one-off script
// (`scripts/backfill-workos-mirror.ts`) can wire real clients, the request
// path can wire `WorkOSClient` (an organization whose mark is missing is
// scanned on demand before its seats are counted), and the test can wire
// fakes against the test database.
//
// Idempotent and repairing: the upserts are guarded on WorkOS `updatedAt`,
// so a re-scan over unchanged data writes nothing new, and every membership
// the mirror holds for the org that WorkOS no longer lists is TOMBSTONED
// (`inactive`, `deleted_at` = the time the listing was taken) — so a re-scan
// repairs a stale row instead of leaving it granting access. `dryRun` reads
// everything and writes nothing, so the printed counts are the plan.
//
// One scan is applied in ONE transaction (`WorkOsMirror.applyOrganizationScan`)
// that first moves the organization's `backfilled_at` forward to the
// listing's instant and writes nothing if a LATER listing already did. Two
// scans of the same organization can overlap (the one-off script and an
// on-demand scan from a request, or a stalled script run and its retry), and
// the `updatedAt` guard alone cannot order them: a scan that listed a
// membership, stalled, and resumed after a later scan had found it gone
// would insert it live — the later scan tombstoned nothing, because the row
// was not there to tombstone. Refusing the older listing whole is what keeps
// a membership revoked between the two listings revoked.
//
// Completeness is tracked PER ORGANIZATION (`organizations.backfilled_at`),
// never database-wide: the mark is written only by a scan that listed that
// organization's memberships in full, so an organization mirrored after a
// backfill ran (lazily by a request, or by a sign-in that records only the
// caller's own membership) starts unmarked and is scanned before any count
// read from the mirror is trusted. A run over every organization
// (`backfillWorkOsMirror`) additionally records the Events API replay
// boundary — the instant it began reading WorkOS — BEFORE anything is
// listed, and only if no boundary is recorded yet. Recording it first, not
// on completion, is what makes a failed run safe to retry: a run that
// fails part-way has already fixed the boundary at its start, and its
// retry reads that boundary back instead of taking a fresh, later one. A
// scan refreshes memberships and tombstones, not organization names or
// deleted users' profiles, so an `organization.updated` or `user.deleted`
// that lands between the attempts (or between two runs) is covered only by
// the events stream — a boundary taken by the retry would fall after it and
// skip it for good, leaving the deleted user's profile in the mirror. The
// reconciler's own cursor takes over from the boundary after its first
// page, so the boundary's only job is to name where that first page starts.
//
// The mark also orders every OTHER membership write against the scan: the
// mirror refuses a membership payload stamped before the organization's
// `backfilled_at` (`upsertMembership`). A login whose membership list was
// fetched before a revocation and written after the scan would otherwise
// reinstate the revoked membership — and that revocation predates the
// events replay boundary, so no event would ever tombstone it again.
// ---------------------------------------------------------------------------

import { Clock, Effect, Option } from "effect";

import {
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsMirrorShape,
  type WorkOsOrganizationScanWrites,
  type WorkOsUserPayload,
} from "./workos-mirror-store";

/** The WorkOS reads one organization's scan performs, over whatever client the caller wires. */
export interface WorkOsOrganizationScanSource<E> {
  /**
   * EVERY membership of one organization, all pages and all statuses
   * (active, pending, inactive). A source that filtered by status would
   * have the scan tombstone what it filtered out — see the header.
   */
  readonly listOrgMembers: (
    organizationId: string,
  ) => Effect.Effect<readonly WorkOsMembershipPayload[], E>;
  readonly getUser: (userId: string) => Effect.Effect<WorkOsUserPayload, E>;
}

/** The reads the full backfill performs: every organization, then each one's scan. */
export interface WorkOsMirrorBackfillSource<E> extends WorkOsOrganizationScanSource<E> {
  /** Every organization id the mirror knows (FK target of `memberships`). */
  readonly listOrganizationIds: () => Effect.Effect<readonly string[], E>;
}

export interface WorkOsMirrorBackfillOptions {
  readonly dryRun: boolean;
  /** One line per organization and one summary line; never a user's data. */
  readonly log: (line: string) => void;
}

/** What one organization's scan did. */
export interface WorkOsOrganizationScanCounts extends WorkOsOrganizationScanWrites {
  /** Memberships WorkOS reported for the organization. */
  readonly memberships: number;
  /**
   * Whether the listing was written to the mirror. `false` on a dry run, and
   * when the mirror refused the listing whole: a later listing of the
   * organization had already been applied (an overlapping scan finished
   * first), or the organization is marked deleted or not mirrored. Every
   * write count is 0 then.
   */
  readonly applied: boolean;
}

const NOTHING_WRITTEN: WorkOsOrganizationScanWrites = {
  usersWritten: 0,
  membershipsWritten: 0,
  membershipsTombstoned: 0,
};

export interface WorkOsMirrorBackfillCounts extends WorkOsOrganizationScanWrites {
  readonly organizations: number;
  /** Memberships WorkOS reported across every organization. */
  readonly memberships: number;
}

// Bounded fan-out for the per-member `getUser` calls: enough to overlap the
// WorkOS round-trips, low enough to stay clear of its rate limit.
const USER_FETCH_CONCURRENCY = 5;

const now = () => Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

/**
 * Scan one organization: list every membership WorkOS holds for it, fetch
 * each member's user, and apply the listing to the mirror in one transaction
 * — the listed users and memberships upserted, the rest tombstoned, the
 * organization marked backfilled as of the listing — unless a later listing
 * was applied first, in which case nothing is written (`applied: false`).
 * The organization row must already be mirrored. Fails on the first source
 * or mirror failure and writes nothing then — a failed scan is safe to
 * repeat, so surfacing the failure beats a silent skip. A dry run reads
 * everything, writes nothing, and marks nothing.
 */
export const backfillOrganization = <E>(
  source: WorkOsOrganizationScanSource<E>,
  mirror: WorkOsMirrorShape,
  organizationId: string,
  options: { readonly dryRun: boolean },
) =>
  Effect.gen(function* () {
    // The listing's own instant, taken BEFORE the read so no change can fall
    // between them: the tombstone time for whatever the listing no longer
    // contains, the cut-off for what may be tombstoned at all (a row stamped
    // at or after it was written after the listing and is not missing from
    // it), and the organization's new `backfilled_at`.
    const listedAt = yield* now();
    const listed = yield* source.listOrgMembers(organizationId);
    const members = yield* Effect.forEach(
      listed,
      (membership) =>
        Effect.map(source.getUser(membership.userId), (user) => ({
          user: mirrorUserFromWorkOs(user),
          membership: mirrorMembershipFromWorkOs(membership),
        })),
      { concurrency: USER_FETCH_CONCURRENCY },
    );
    if (options.dryRun) {
      const counts: WorkOsOrganizationScanCounts = {
        ...NOTHING_WRITTEN,
        memberships: members.length,
        applied: false,
      };
      return counts;
    }
    const written = yield* mirror.applyOrganizationScan({
      organizationId,
      listedAt,
      members,
    });
    if (Option.isNone(written)) {
      yield* Effect.logWarning(
        "workos_mirror: organization scan not applied — a later listing was already applied, or the organization is deleted or not mirrored",
        { organizationId, listedAt: listedAt.toISOString() },
      );
    }
    const counts: WorkOsOrganizationScanCounts = {
      ...Option.getOrElse(written, () => NOTHING_WRITTEN),
      memberships: members.length,
      applied: Option.isSome(written),
    };
    return counts;
  }).pipe(
    Effect.withSpan("workos_mirror.backfillOrganization", {
      attributes: { organizationId },
    }),
  );

/**
 * Run the full backfill: record the Events API replay boundary if none is
 * recorded yet, then scan every organization the mirror knows. Fails on the
 * first source or mirror failure — the organizations scanned so far stay
 * marked (each was covered in full), the boundary recorded at the start
 * stands, and the run is safe to repeat: the retry keeps that boundary, so
 * every change since the first attempt began is the reconciler's to replay.
 */
export const backfillWorkOsMirror = <E>(
  source: WorkOsMirrorBackfillSource<E>,
  mirror: WorkOsMirrorShape,
  options: WorkOsMirrorBackfillOptions,
) =>
  Effect.gen(function* () {
    // The replay boundary: taken AND recorded before anything is listed, so
    // every change from this instant on is the events stream's to apply —
    // one that lands while this run is still listing, or between this run
    // failing part-way and its retry. Kept only when none is recorded yet
    // (`setReplayBoundary`): a retry or a later run reads the first one
    // back instead of moving it. A dry run records nothing.
    const boundary = yield* now();
    if (!options.dryRun) {
      const recorded = yield* mirror.setReplayBoundary(boundary);
      options.log(
        recorded
          ? `events replay boundary set to ${boundary.toISOString()}`
          : "events replay boundary already recorded by an earlier run; kept (the events reconciler replays every change since it)",
      );
    }

    const organizationIds = yield* source.listOrganizationIds();
    let memberships = 0;
    let usersWritten = 0;
    let membershipsWritten = 0;
    let membershipsTombstoned = 0;

    for (const organizationId of organizationIds) {
      const scanned = yield* backfillOrganization(source, mirror, organizationId, options);
      memberships += scanned.memberships;
      usersWritten += scanned.usersWritten;
      membershipsWritten += scanned.membershipsWritten;
      membershipsTombstoned += scanned.membershipsTombstoned;
      options.log(
        `${organizationId}  ${scanned.memberships} membership(s)` +
          (options.dryRun
            ? ""
            : scanned.applied
              ? `  wrote ${scanned.usersWritten} user(s), ${scanned.membershipsWritten} membership(s), tombstoned ${scanned.membershipsTombstoned}`
              : "  not applied (a later listing was already applied, or the organization is deleted)"),
      );
    }

    const counts: WorkOsMirrorBackfillCounts = {
      organizations: organizationIds.length,
      memberships,
      usersWritten,
      membershipsWritten,
      membershipsTombstoned,
    };
    options.log(
      options.dryRun
        ? `dry run — ${counts.organizations} organization(s), ${counts.memberships} membership(s) would be mirrored`
        : `${counts.organizations} organization(s), ${counts.memberships} membership(s): wrote ${counts.usersWritten} user(s), ${counts.membershipsWritten} membership(s), tombstoned ${counts.membershipsTombstoned}`,
    );
    if (!options.dryRun) {
      // Every live organization is now covered (a failure above fails the
      // whole run): the mirror is complete enough to authorize from, once
      // the reconciler has caught up too — the first half of the readiness
      // the authorization path checks. Once: a re-run keeps the first
      // completion.
      const completedAt = yield* now();
      const marked = yield* mirror.markBackfillCompleted(completedAt);
      options.log(
        marked
          ? `backfill completion recorded at ${completedAt.toISOString()}`
          : "backfill completion already recorded by an earlier run; kept",
      );
    }
    return counts;
  });
