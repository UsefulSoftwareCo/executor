// ---------------------------------------------------------------------------
// The membership mirror's request-path FEEDERS: the writes the login callback
// and the Executor-initiated membership changes make through `WorkOsMirror`.
//
// Each feeder takes the WorkOS payload the caller ALREADY holds (the
// authenticated user, the membership list the callback fetches to pick a
// landing org, the membership a write returned) so feeding the mirror never
// adds a WorkOS read — except the two writes whose WorkOS response is not the
// membership they changed: invitation acceptance (`auth/handlers.ts` reads
// the activated membership back) and sending an invitation
// (`mirrorInvitedMember` below reads the pending one WorkOS created). Both
// are rare, admin-driven paths. Mirror failures fail the request: the mirror
// is the membership read path, so a login that could not record its
// memberships is not a login that finished.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { normalizeAdminUserEmail } from "@executor-js/api/server";

import { UserStoreService } from "./context";
import { WorkOSClient } from "./workos";
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

// Bounded fan-out for the per-invitee `getUser` calls, matching the backfill:
// enough to overlap WorkOS round-trips, low enough to stay clear of its rate
// limit.
const USER_FETCH_CONCURRENCY = 5;

/**
 * Record the PENDING membership WorkOS creates for an invitee the moment an
 * organization invites them — the row the member list shows as "Invited" and
 * the admin revokes an outstanding invite through. `sendInvitation` returns
 * the invitation, not that membership, so this reads it back: it lists the
 * organization's pending memberships (WorkOS has no lookup by email that the
 * emulator serves) and fetches their users, five at a time, until one carries
 * the invited email. Bounded by the pending set, so an organization with
 * many active members pays nothing per member.
 *
 * `false` when no pending membership carried the email — WorkOS created none
 * (the address may already hold a membership) or has not yet — which the
 * caller treats as a warning, not a failure: the Events reconciler lands
 * whatever WorkOS did create.
 */
export const mirrorInvitedMember = Effect.fn("workos_mirror.invitedMember")(function* (
  organizationId: string,
  invitedEmail: string,
) {
  const workos = yield* WorkOSClient;
  const mirror = yield* WorkOsMirror;
  const wanted = normalizeAdminUserEmail(invitedEmail);
  const pending = yield* workos.listOrgMembers(organizationId, ["pending"]);
  for (let start = 0; start < pending.data.length; start += USER_FETCH_CONCURRENCY) {
    const batch = pending.data.slice(start, start + USER_FETCH_CONCURRENCY);
    const candidates = yield* Effect.forEach(
      batch,
      (membership) =>
        Effect.map(workos.getUser(membership.userId), (user) => ({ membership, user })),
      { concurrency: USER_FETCH_CONCURRENCY },
    );
    const match = candidates.find(
      (candidate) => normalizeAdminUserEmail(candidate.user.email) === wanted,
    );
    if (match === undefined) continue;
    yield* mirror.upsertUser(mirrorUserFromWorkOs(match.user));
    yield* mirror.upsertMembership(mirrorMembershipFromWorkOs(match.membership));
    return true;
  }
  return false;
});
