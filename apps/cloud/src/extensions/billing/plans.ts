// Plan IDs mirror the Autumn plan definitions in the repo-root
// `autumn.config.ts` (the deploy-time source synced via `atmn`). These IDs are
// stable, so we keep them as literals here rather than importing the config
// across the app boundary.

export const ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

// ---------------------------------------------------------------------------
// Execution rate-limit exemption.
//
// The hourly execution backstop exists for FREE-tier abuse, so the only orgs
// it may cap are those with nothing but the Free plan. The exemption is
// "anything but Free", not a list of the plans sold today: every other plan
// an org can legitimately hold — grandfathered (`hobby`, `professional`),
// pay-as-you-go, or one added later — must stay uncapped. A paying customer
// blocked by an abuse backstop is the worse failure.
// ---------------------------------------------------------------------------

export const FREE_AUTUMN_PLAN_ID = "free";

export const hasNonFreeOrganizationSubscription = (
  subscriptions: ReadonlyArray<AutumnSubscriptionSummary>,
): boolean =>
  subscriptions.some(
    (subscription) =>
      subscription.planId != null &&
      subscription.planId !== FREE_AUTUMN_PLAN_ID &&
      ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES.has(subscription.status ?? ""),
  );

// ---------------------------------------------------------------------------
// Per-plan member seat limits — the org member seat-gate (reserveMemberSlot).
// Reads the same Autumn plan config. Used by the account provider seat-gate.
// ---------------------------------------------------------------------------

const MEMBER_LIMITS: Record<string, number | null> = {
  free: 3,
  "free-pay-as-you-go": 3,
  team: null,
  enterprise: null,
};

export const DEFAULT_MEMBER_LIMIT = 3;

export type AutumnSubscriptionSummary = {
  readonly planId?: string | null;
  readonly status?: string | null;
};

export const selectActiveMemberLimitPlan = (
  subscriptions: ReadonlyArray<AutumnSubscriptionSummary>,
): string => {
  const active =
    subscriptions.find((subscription) =>
      ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES.has(subscription.status ?? ""),
    ) ?? subscriptions[0];
  return active?.planId ?? "free";
};

export const getMemberLimitForPlan = (planId: string): number | null =>
  planId in MEMBER_LIMITS ? MEMBER_LIMITS[planId] : DEFAULT_MEMBER_LIMIT;

/** A seat-occupying membership: active members AND invited-but-not-joined
 *  users both come back from `listOrganizationMemberships`, the latter with
 *  status "pending". */
export type SeatMembership = { readonly status: string };

/**
 * Seats consumed by an organization, without double-counting outstanding
 * invites. WorkOS represents an unaccepted invite as BOTH a pending membership
 * (returned by `listOrganizationMemberships`) AND a pending invitation
 * (returned by `listInvitations`) for the same person, so summing the two
 * counted every invite twice and refused new invites below the advertised
 * limit. Active members always count; the invited set is the SAME people in
 * both lists, so take the larger of the two rather than adding them.
 */
export const countSeatsUsed = (
  memberships: ReadonlyArray<SeatMembership>,
  pendingInvitationCount: number,
): number => {
  const active = memberships.filter((m) => m.status === "active").length;
  const pendingMembers = memberships.filter((m) => m.status === "pending").length;
  return active + Math.max(pendingMembers, pendingInvitationCount);
};
