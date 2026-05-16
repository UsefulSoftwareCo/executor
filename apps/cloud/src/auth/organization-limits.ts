import {
  ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES,
  PAID_AUTUMN_PLAN_IDS,
} from "../services/autumn-plans";

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
