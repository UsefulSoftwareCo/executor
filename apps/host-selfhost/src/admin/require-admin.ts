// ---------------------------------------------------------------------------
// THE self-host admin gate. One implementation, shared by every admin plane:
// the invite-code API (`handlers.ts`) and the admin users API
// (`admin-users-api.ts`). Both planes report on, or grant power over, the whole
// instance, so they must agree on exactly who counts as an admin — and there is
// only one way to be wrong here, so there is only one place to be right.
//
// WHY THIS IS NOT `getActiveMember`.
//
// Both planes previously authorized with `auth.api.getActiveMember({ headers
// })`. That endpoint resolves the caller's membership in
// `session.activeOrganizationId` — a field the CALLER controls. Better Auth's
// organization plugin exposes `POST /organization/create` (mounted bare,
// `allowUserToCreateOrganization` defaults to true) and `POST
// /organization/set-active`, so any authenticated member could create an
// organization of their own, become its `owner` (the creator role), have that
// org set active, and then present a session whose active org is one they own.
// `getActiveMember` would answer `role: "owner"` — for THEIR org — and the gate
// would open. Meanwhile the reads underneath are scoped to the instance's
// boot-seeded org, so the escalated caller read the real instance: every user's
// externalId/createdAt/lastSeenAt and their whole connection inventory on one
// plane, and a live `role: "admin"` invite code (durable escalation) on the
// other.
//
// The bug is that the gate and the data disagreed about WHICH organization the
// request was about. This gate removes the disagreement by naming the
// instance's organization explicitly, so the authorization decision is made
// against the same org the reads are scoped to and nothing the caller sends can
// redirect it.
//
// HOW. `getActiveMemberRole` accepts an explicit `organizationId` query, and
// when given one it ignores `session.activeOrganizationId` entirely, looks up
// the caller's membership in THAT org, and refuses with FORBIDDEN when there
// isn't one (better-auth 1.6.12, `plugins/organization/routes/crud-members.mjs`
// — read against the installed build, not the docs). So a caller who owns ten
// organizations of their own still resolves to "not a member of the instance
// org" unless they were actually invited to it. There is no
// `member.organizationId !== organizationId` check to write, because the query
// makes the mismatch unrepresentable rather than detectable.
//
// Defense in depth lives in `auth/better-auth.ts`, which now mounts
// `organization({ allowUserToCreateOrganization: false })` so the first step of
// the escalation is refused too. Either fix alone closes the hole; the gate is
// the load-bearing one, because it is what makes the authorization decision
// correct rather than merely making one route to it harder.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { BetterAuth } from "../auth/better-auth";

/**
 * Why the caller was refused, in the vocabulary both planes share.
 *
 * The two planes render refusals through their OWN error classes
 * (`AdminUnauthorized` / `AdminUsersUnauthorized`, and so on), because those
 * are what their respective HttpApi contracts declare. So the gate decides, and
 * each caller translates — rather than the gate importing one plane's errors
 * and the other plane mapping between two error vocabularies.
 */
export type AdminGateDenial = "unauthorized" | "forbidden";

/** What a caller who passed the gate is. `userId` is the Better Auth `user.id`
 *  — the same id `auth/identity.ts` binds as the accountId, which is what the
 *  invite plane records as `createdBy`. */
export interface InstanceAdmin {
  readonly userId: string;
  readonly role: string;
}

/**
 * Better Auth writes a member's roles as a comma-separated list (its own
 * `leaveOrganization` reads them with `role.split(",")`), so a single-role
 * string is the common case rather than the contract. Membership in the
 * privileged set is therefore tested per role, not by equality on the whole
 * field — an `"owner,admin"` value must not read as neither.
 *
 * Exported for the identity seam: the same "who counts as an admin" answer
 * decides the executor's workspace-write binding (`Principal.orgRole`), and
 * there is only one place to be right about it.
 */
export const isPrivileged = (role: string): boolean =>
  role
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "owner" || part === "admin");

/**
 * Authorize the caller as an owner/admin OF THE INSTANCE'S ORGANIZATION.
 *
 * Fails with `"unauthorized"` when there is no session at all, and
 * `"forbidden"` when there is a session that is not an owner/admin member of
 * the instance org — including a session belonging to an owner of some OTHER
 * organization, which is the escalation this gate exists to refuse.
 *
 * Both Better Auth calls FAIL CLOSED, and closed means the less-informative
 * answer of the two: a `getSession` that throws is treated as "no session"
 * (401) and a `getActiveMemberRole` that throws is treated as "not entitled"
 * (403), because the endpoint's own way of saying "you are not a member of this
 * organization" IS a thrown FORBIDDEN. An infrastructure fault therefore
 * refuses the request rather than surfacing as a 500, which is the correct
 * trade on a plane where the wrong answer is a disclosure.
 *
 * TWO CALLS, NOT ONE. The session read is what distinguishes 401 from 403 — the
 * role endpoint cannot, since it refuses the anonymous and the unentitled with
 * the same status — and it is also where `userId` comes from, since the role
 * endpoint answers with a role and nothing else.
 */
export const requireInstanceAdmin = (
  headers: Headers,
): Effect.Effect<InstanceAdmin, AdminGateDenial, BetterAuth> =>
  Effect.gen(function* () {
    const { auth, organizationId } = yield* BetterAuth;

    const session = yield* Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session) return yield* Effect.fail<AdminGateDenial>("unauthorized");

    // The whole fix in one argument: the org is named by the INSTANCE, never
    // read from the caller's session.
    const resolved = yield* Effect.tryPromise(() =>
      auth.api.getActiveMemberRole({ headers, query: { organizationId } }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!resolved || !isPrivileged(resolved.role)) {
      return yield* Effect.fail<AdminGateDenial>("forbidden");
    }

    return { userId: session.user.id, role: resolved.role };
  });
