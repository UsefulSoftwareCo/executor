// ---------------------------------------------------------------------------
// The membership mirror's request-path FEEDERS: the writes the login callback
// and the Executor-initiated membership changes make through `WorkOsMirror`.
//
// Each feeder takes the WorkOS payload the caller ALREADY holds (the
// authenticated user, the membership list the callback fetches to pick a
// landing org, the membership a write returned) so feeding the mirror never
// adds a WorkOS read. Mirror failures fail the request: the mirror is the
// membership read path, so a login that could not record its memberships is
// not a login that finished.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { UserStoreService } from "./context";
import {
  WorkOsMirror,
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsUserPayload,
} from "./workos-mirror";

/**
 * A membership as WorkOS lists it for a user: carries the organization's name,
 * which is what lets the sign-in feeder mirror the org row without a
 * `getOrganization` call. `OrganizationMembership` from the SDK satisfies it.
 */
export interface WorkOsSignInMembership extends WorkOsMembershipPayload {
  readonly organizationName: string;
}

/**
 * Record a sign-in: the user's profile, then every organization WorkOS lists
 * them in (the org row first, so the membership's foreign key holds) and the
 * membership itself. Replays converge: every write is guarded on WorkOS
 * `updatedAt`, so a second login with the same payload changes nothing.
 *
 * `fetchedAt` is the instant the membership list was requested — taken
 * BEFORE the WorkOS read, so nothing that changed after it can be mistaken
 * for older. A membership list names each organization but carries no
 * organization timestamp, so `fetchedAt` is the stamp its name is written
 * under: a list fetched before a rename (a login that stalled) cannot revert
 * the rename after it landed. A membership of an organization the mirror
 * holds as deleted is refused by the mirror, and the organization is neither
 * re-minted nor renamed: a list fetched before a deletion cannot restore the
 * organization after its purge. And a membership stamped before the
 * organization's last full scan (`organizations.backfilled_at`) is refused
 * too: a list fetched before a revocation and written after the scan that
 * found the membership gone cannot reinstate it.
 */
export const mirrorSignIn = Effect.fn("workos_mirror.signIn")(function* (
  user: WorkOsUserPayload,
  memberships: readonly WorkOsSignInMembership[],
  fetchedAt: Date,
) {
  const mirror = yield* WorkOsMirror;
  const users = yield* UserStoreService;
  yield* mirror.upsertUser(mirrorUserFromWorkOs(user));
  for (const membership of memberships) {
    yield* users.use("upsertOrganization", (s) =>
      s.upsertOrganization({
        id: membership.organizationId,
        name: membership.organizationName,
        updatedAt: fetchedAt,
      }),
    );
    yield* mirror.upsertMembership(mirrorMembershipFromWorkOs(membership));
  }
});

/**
 * Record one membership WorkOS just returned to a write (create, role
 * change, invitation acceptance). The organization must already be mirrored;
 * every caller has just upserted it or resolved it through the mirror.
 */
export const mirrorMembership = (membership: WorkOsMembershipPayload) =>
  Effect.flatMap(WorkOsMirror.asEffect(), (mirror) =>
    mirror.upsertMembership(mirrorMembershipFromWorkOs(membership)),
  );
