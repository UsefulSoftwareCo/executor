// ---------------------------------------------------------------------------
// One-off backfill of the membership mirror from WorkOS: for every mirrored
// organization, list its active + pending memberships, fetch each member's
// user, and write both through the mirror's guarded upserts. The core is a
// pure function over a `source` (WorkOS reads + the org list) and the mirror
// store so `scripts/backfill-workos-mirror.ts` can wire real clients and the
// test can wire fakes against the test database.
//
// Idempotent: the upserts are guarded on WorkOS `updatedAt`, so a re-run over
// unchanged data writes nothing (`usersWritten` / `membershipsWritten` count
// only rows the guard let through). `dryRun` reads everything and writes
// nothing, so the printed counts are the plan.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsMirrorShape,
  type WorkOsUserPayload,
} from "./workos-mirror-store";

/** The reads the backfill performs, over whatever client the caller wires. */
export interface WorkOsMirrorBackfillSource<E> {
  /** Every organization id the mirror knows (FK target of `memberships`). */
  readonly listOrganizationIds: () => Effect.Effect<readonly string[], E>;
  /** Active + pending memberships of one organization, all pages. */
  readonly listOrgMembers: (
    organizationId: string,
  ) => Effect.Effect<readonly WorkOsMembershipPayload[], E>;
  readonly getUser: (userId: string) => Effect.Effect<WorkOsUserPayload, E>;
}

export interface WorkOsMirrorBackfillOptions {
  readonly dryRun: boolean;
  /** One line per organization and one summary line; never a user's data. */
  readonly log: (line: string) => void;
}

export interface WorkOsMirrorBackfillCounts {
  readonly organizations: number;
  /** Memberships WorkOS reported across every organization. */
  readonly memberships: number;
  /** Upserts the `updatedAt` guard let through (0 on a dry run). */
  readonly usersWritten: number;
  readonly membershipsWritten: number;
}

// Bounded fan-out for the per-member `getUser` calls: enough to overlap the
// WorkOS round-trips, low enough to stay clear of its rate limit.
const USER_FETCH_CONCURRENCY = 5;

/**
 * Run the backfill. Fails on the first source or mirror failure — a partial
 * run is safe to repeat, so surfacing the failure beats a silent skip.
 */
export const backfillWorkOsMirror = <E>(
  source: WorkOsMirrorBackfillSource<E>,
  mirror: WorkOsMirrorShape,
  options: WorkOsMirrorBackfillOptions,
) =>
  Effect.gen(function* () {
    const organizationIds = yield* source.listOrganizationIds();
    let memberships = 0;
    let usersWritten = 0;
    let membershipsWritten = 0;

    for (const organizationId of organizationIds) {
      const members = yield* source.listOrgMembers(organizationId);
      const written = yield* Effect.forEach(
        members,
        (membership) =>
          Effect.gen(function* () {
            const user = yield* source.getUser(membership.userId);
            if (options.dryRun) return { user: false, membership: false };
            const userWritten = yield* mirror.upsertUser(mirrorUserFromWorkOs(user));
            const membershipWritten = yield* mirror.upsertMembership(
              mirrorMembershipFromWorkOs(membership),
            );
            return { user: userWritten, membership: membershipWritten };
          }),
        { concurrency: USER_FETCH_CONCURRENCY },
      );
      const orgUsers = written.filter((w) => w.user).length;
      const orgMemberships = written.filter((w) => w.membership).length;
      memberships += members.length;
      usersWritten += orgUsers;
      membershipsWritten += orgMemberships;
      options.log(
        `${organizationId}  ${members.length} membership(s)` +
          (options.dryRun ? "" : `  wrote ${orgUsers} user(s), ${orgMemberships} membership(s)`),
      );
    }

    const counts: WorkOsMirrorBackfillCounts = {
      organizations: organizationIds.length,
      memberships,
      usersWritten,
      membershipsWritten,
    };
    options.log(
      options.dryRun
        ? `dry run — ${counts.organizations} organization(s), ${counts.memberships} membership(s) would be mirrored`
        : `${counts.organizations} organization(s), ${counts.memberships} membership(s): wrote ${counts.usersWritten} user(s), ${counts.membershipsWritten} membership(s)`,
    );
    return counts;
  });
