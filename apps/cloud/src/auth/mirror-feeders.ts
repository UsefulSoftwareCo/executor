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
 */
export const mirrorSignIn = Effect.fn("workos_mirror.signIn")(function* (
  user: WorkOsUserPayload,
  memberships: readonly WorkOsSignInMembership[],
) {
  const mirror = yield* WorkOsMirror;
  const users = yield* UserStoreService;
  yield* mirror.upsertUser(mirrorUserFromWorkOs(user));
  for (const membership of memberships) {
    yield* users.use("upsertOrganization", (s) =>
      s.upsertOrganization({
        id: membership.organizationId,
        name: membership.organizationName,
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
