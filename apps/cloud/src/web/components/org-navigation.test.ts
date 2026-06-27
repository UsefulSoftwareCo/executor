import { describe, expect, it } from "@effect/vitest";

import { organizationNavigationHref } from "./org-navigation";

describe("organizationNavigationHref", () => {
  it("replaces the organization while preserving route, query, and hash", () => {
    expect(
      organizationNavigationHref("org-b", {
        pathname: "/org-a/policies",
        search: "?owner=user",
        hash: "#rules",
      }),
    ).toBe("/org-b/policies?owner=user#rules");
  });

  it("adds an organization to a bare deep link", () => {
    expect(
      organizationNavigationHref("org-b", {
        pathname: "/policies",
        search: "?owner=org",
        hash: "",
      }),
    ).toBe("/org-b/policies?owner=org");
  });

  it("lands a root route at the target organization root", () => {
    expect(organizationNavigationHref("org-b", { pathname: "/", search: "", hash: "#top" })).toBe(
      "/org-b#top",
    );
  });
});
