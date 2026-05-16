import { describe, expect, it } from "@effect/vitest";

import {
  FREE_ORGANIZATIONS_PER_USER_LIMIT,
  hasPaidOrganizationSubscription,
  isOverFreeOrganizationLimit,
  shouldApplyFreeOrganizationLimit,
} from "./organization-limits";

describe("organization limits", () => {
  it("treats active and trialing paid org subscriptions as paid", () => {
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "active" }])).toBe(true);
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "trialing" }])).toBe(true);
  });

  it("does not treat inactive paid plans or free plans as paid", () => {
    expect(hasPaidOrganizationSubscription([{ planId: "team", status: "canceled" }])).toBe(false);
    expect(hasPaidOrganizationSubscription([{ planId: "free", status: "active" }])).toBe(false);
    expect(hasPaidOrganizationSubscription([{ planId: null, status: "active" }])).toBe(false);
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
