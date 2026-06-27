// Paid plan IDs, mirroring the Autumn plan definitions in the repo-root
// `autumn.config.ts` (the deploy-time source synced via `atmn`). These IDs are
// stable, so we keep them as literals here rather than importing the config
// across the app boundary.
export const PAID_AUTUMN_PLAN_IDS = new Set(["team", "enterprise"]);

export const ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

// ---------------------------------------------------------------------------
// Free-tier organization-creation limit — the createOrganization gate.
//
// These predicates read the Autumn plan config above, so they live with the
// billing config (NOT in `auth/organization.ts`, which the billing-free MCP
// session DO bundle reaches). Used only by `auth/handlers.ts`'s
// `createOrganization` handler.
// ---------------------------------------------------------------------------

export const FREE_ORGANIZATIONS_PER_USER_LIMIT = 3;

export type OrganizationLimitSubscriptionSummary = {
  readonly planId?: string | null;
  readonly status?: string | null;
};

export type OrganizationLimitMembershipSummary = {
  readonly organizationId: string;
  readonly status?: string | null;
};

export const isPaidOrganizationSubscription = (
  subscription: OrganizationLimitSubscriptionSummary,
): boolean =>
  subscription.planId != null &&
  PAID_AUTUMN_PLAN_IDS.has(subscription.planId) &&
  ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES.has(subscription.status ?? "");

export const hasPaidOrganizationSubscription = (
  subscriptions: ReadonlyArray<OrganizationLimitSubscriptionSummary>,
): boolean => subscriptions.some(isPaidOrganizationSubscription);

export const shouldApplyFreeOrganizationLimit = (
  activeMemberships: ReadonlyArray<OrganizationLimitMembershipSummary>,
  paidOrganizationIds: ReadonlySet<string>,
): boolean =>
  !activeMemberships.some((membership) => paidOrganizationIds.has(membership.organizationId));

export const isOverFreeOrganizationLimit = (
  activeMemberships: ReadonlyArray<OrganizationLimitMembershipSummary>,
): boolean => activeMemberships.length >= FREE_ORGANIZATIONS_PER_USER_LIMIT;

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
