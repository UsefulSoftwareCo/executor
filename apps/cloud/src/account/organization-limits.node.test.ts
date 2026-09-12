import { describe, expect, it } from "@effect/vitest";

import {
  FREE_ORGANIZATIONS_PER_USER_LIMIT,
  hasNonFreeOrganizationSubscription,
  hasPaidOrganizationSubscription,
  isOverFreeOrganizationLimit,
  shouldApplyFreeOrganizationLimit,
} from "../extensions/billing/plans";

describe("organization limits", () => {
  it("treats active and trialing paid org subscriptions as paid", () => {
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "active" }])).toBe(true);
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "trialing" }])).toBe(true);
    expect(hasPaidOrganizationSubscription([{ planId: "enterprise", status: "active" }])).toBe(
      true,
    );
  });

  it("does not treat inactive paid plans or free plans as paid", () => {
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "canceled" }])).toBe(false);
    expect(hasPaidOrganizationSubscription([{ planId: "free", status: "active" }])).toBe(false);
    expect(hasPaidOrganizationSubscription([{ planId: null, status: "active" }])).toBe(false);
  });

  it("exempts any active non-free subscription from the execution rate limit", () => {
    expect(hasNonFreeOrganizationSubscription([{ planId: "team", status: "active" }])).toBe(true);
    expect(hasNonFreeOrganizationSubscription([{ planId: "enterprise", status: "trialing" }])).toBe(
      true,
    );
    // Grandfathered and pay-as-you-go plans are not in the paid set, but they
    // are not Free either — the backstop must never cap them.
    expect(hasNonFreeOrganizationSubscription([{ planId: "professional", status: "active" }])).toBe(
      true,
    );
    expect(hasNonFreeOrganizationSubscription([{ planId: "hobby", status: "active" }])).toBe(true);
    expect(
      hasNonFreeOrganizationSubscription([{ planId: "free-pay-as-you-go", status: "active" }]),
    ).toBe(true);
    expect(
      hasNonFreeOrganizationSubscription([
        { planId: "free", status: "active" },
        { planId: "team", status: "active" },
      ]),
    ).toBe(true);
  });

  it("rate-limits orgs that hold nothing but Free or inactive subscriptions", () => {
    expect(hasNonFreeOrganizationSubscription([])).toBe(false);
    expect(hasNonFreeOrganizationSubscription([{ planId: "free", status: "active" }])).toBe(false);
    expect(hasNonFreeOrganizationSubscription([{ planId: "team", status: "canceled" }])).toBe(
      false,
    );
    expect(hasNonFreeOrganizationSubscription([{ planId: null, status: "active" }])).toBe(false);
  });

  it("applies the free org limit only when none of the user's active orgs are paid", () => {
    const activeMemberships = [
      { organizationId: "org_free_1", status: "active" },
      { organizationId: "org_paid", status: "active" },
    ];

    expect(shouldApplyFreeOrganizationLimit(activeMemberships, new Set())).toBe(true);
    expect(shouldApplyFreeOrganizationLimit(activeMemberships, new Set(["org_paid"]))).toBe(false);
  });

  it("caps free-only users at active org memberships, not pending invitations", () => {
    expect(
      isOverFreeOrganizationLimit(
        Array.from({ length: FREE_ORGANIZATIONS_PER_USER_LIMIT - 1 }, (_, index) => ({
          organizationId: `org_${index}`,
          status: "active",
        })),
      ),
    ).toBe(false);

    expect(
      isOverFreeOrganizationLimit(
        Array.from({ length: FREE_ORGANIZATIONS_PER_USER_LIMIT }, (_, index) => ({
          organizationId: `org_${index}`,
          status: "active",
        })),
      ),
    ).toBe(true);
  });
});
