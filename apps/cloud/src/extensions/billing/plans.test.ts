import { describe, expect, it } from "@effect/vitest";

import { countSeatsUsed } from "./plans";

// WorkOS returns an unaccepted invite as BOTH a pending organization membership
// AND a pending invitation for the same person. The seat count must not add the
// two, or every outstanding invite is counted twice and new invites get refused
// below the advertised limit (the reported bug: a free org with 1 member + 1
// pending invite was treated as 3 seats used and could not invite a third).
describe("countSeatsUsed", () => {
  it("does not double-count an invite that is both a pending membership and an invitation", () => {
    const memberships = [{ status: "active" }, { status: "pending" }];
    // 1 active + 1 pending member, and the same person also as 1 invitation.
    expect(countSeatsUsed(memberships, 1)).toBe(2);
  });

  it("counts invitations that have no pending membership yet (e.g. emulated WorkOS)", () => {
    // Only the active admin is a membership; the invites exist only as
    // invitations. They still occupy seats.
    expect(countSeatsUsed([{ status: "active" }], 2)).toBe(3);
  });

  it("fills exactly to the cap: owner plus two invites is three", () => {
    const atCap = [{ status: "active" }, { status: "pending" }, { status: "pending" }];
    expect(countSeatsUsed(atCap, 2)).toBe(3);
  });

  it("counts only the owner when there are no invites", () => {
    expect(countSeatsUsed([{ status: "active" }], 0)).toBe(1);
  });

  it("ignores inactive memberships", () => {
    expect(countSeatsUsed([{ status: "active" }, { status: "inactive" }], 0)).toBe(1);
  });

  it("counts a pending membership even if its invitation already cleared", () => {
    expect(countSeatsUsed([{ status: "active" }, { status: "pending" }], 0)).toBe(2);
  });
});
