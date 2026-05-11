import { describe, expect, it } from "@effect/vitest";

import { getMemberLimitForPlan, selectActiveMemberLimitPlan } from "./member-limits";

describe("member limits", () => {
  it("uses an active or trialing subscription before older entries", () => {
    expect(
      selectActiveMemberLimitPlan([
        { planId: "free", status: "canceled" },
        { planId: "team", status: "trialing" },
      ]),
    ).toBe("team");

    expect(
      selectActiveMemberLimitPlan([
        { planId: "free", status: "past_due" },
        { planId: "team", status: "active" },
      ]),
    ).toBe("team");
  });

  it("falls back to the first subscription, then the free plan", () => {
    expect(
      selectActiveMemberLimitPlan([
        { planId: "free-pay-as-you-go", status: "canceled" },
        { planId: "team", status: "incomplete" },
      ]),
    ).toBe("free-pay-as-you-go");

    expect(selectActiveMemberLimitPlan([])).toBe("free");
  });

  it("resolves member limits from the selected plan", () => {
    expect(getMemberLimitForPlan("free")).toBe(3);
    expect(getMemberLimitForPlan("team")).toBeNull();
    expect(getMemberLimitForPlan("unknown")).toBe(3);
  });
});
