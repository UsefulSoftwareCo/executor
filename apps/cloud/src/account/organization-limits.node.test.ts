import { describe, expect, it } from "@effect/vitest";

import { hasNonFreeOrganizationSubscription } from "../extensions/billing/plans";

describe("organization limits", () => {
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
});
