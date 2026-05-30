import { enterprise, team } from "../../autumn.config";

export const PAID_AUTUMN_PLAN_IDS = new Set([team.id, enterprise.id]);

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
