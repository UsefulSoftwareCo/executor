const MEMBER_LIMITS: Record<string, number | null> = {
  free: 3,
  "free-pay-as-you-go": 3,
  team: null,
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
      ["active", "trialing"].includes(subscription.status ?? ""),
    ) ?? subscriptions[0];
  return active?.planId ?? "free";
};

export const getMemberLimitForPlan = (planId: string): number | null =>
  planId in MEMBER_LIMITS ? MEMBER_LIMITS[planId] : DEFAULT_MEMBER_LIMIT;
