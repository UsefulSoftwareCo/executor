import { describe, expect, it } from "@effect/vitest";

import { activeOrganizationMemberships } from "./organization-memberships";

describe("activeOrganizationMemberships", () => {
  it("keeps active memberships and excludes pending or inactive memberships", () => {
    const memberships = [
      { id: "active-a", status: "active" },
      { id: "pending", status: "pending" },
      { id: "inactive", status: "inactive" },
      { id: "active-b", status: "active" },
    ];

    expect(activeOrganizationMemberships(memberships).map(({ id }) => id)).toEqual([
      "active-a",
      "active-b",
    ]);
  });
});
