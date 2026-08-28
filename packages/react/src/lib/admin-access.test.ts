import { describe, expect, it } from "@effect/vitest";

import { isTenantAdminMember, type TenantMemberRow } from "./admin-access";

const member = (overrides: Partial<TenantMemberRow> = {}): TenantMemberRow => ({
  role: "member",
  status: "active",
  isCurrentUser: false,
  ...overrides,
});

describe("isTenantAdminMember", () => {
  it("an active admin of the tenant may see the admin sections", () => {
    expect(isTenantAdminMember([member({ role: "admin", isCurrentUser: true })])).toBe(true);
  });

  // Self-host (Better Auth) issues `owner` where cloud (WorkOS) issues `admin`;
  // both hosts' admin middleware accept either.
  it("self-host's owner role counts too", () => {
    expect(isTenantAdminMember([member({ role: "owner", isCurrentUser: true })])).toBe(true);
  });

  it("a plain member does not", () => {
    expect(isTenantAdminMember([member({ role: "member", isCurrentUser: true })])).toBe(false);
  });

  // A pending invite carries a role but no access yet — treating it as admin
  // would show a section the server refuses.
  it("a pending admin invite is not yet an admin", () => {
    expect(
      isTenantAdminMember([member({ role: "admin", status: "pending", isCurrentUser: true })]),
    ).toBe(false);
  });

  it("another member's admin role says nothing about the viewer", () => {
    expect(
      isTenantAdminMember([
        member({ role: "admin", isCurrentUser: false }),
        member({ role: "member", isCurrentUser: true }),
      ]),
    ).toBe(false);
  });

  it("fails closed when the list has no row for the viewer", () => {
    expect(isTenantAdminMember([])).toBe(false);
    expect(isTenantAdminMember([member({ role: "admin" })])).toBe(false);
  });

  it("an unknown role is not an admin", () => {
    expect(isTenantAdminMember([member({ role: "billing", isCurrentUser: true })])).toBe(false);
  });
});
