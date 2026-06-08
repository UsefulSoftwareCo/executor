import { describe, expect, it } from "@effect/vitest";

import {
  connectionOwnerOptions,
  connectionOwnerOptionsForHost,
  defaultConnectionOwnerForHost,
  normalizeConnectionOwner,
  resolveConnectionOwnerForHost,
  resolveOAuthConnectionOwnerForHost,
} from "./connection-owner";

// ---------------------------------------------------------------------------
// The connection owner selection defaults to Personal (`user`). The
// shared `useConnectionOwner` hook seeds React state with `"user"` when
// no `initialOwner` is passed, and the options list Personal first so the
// fallback (`options[0]`) is Personal too. These pure invariants pin that
// default without a DOM/React renderer.
// ---------------------------------------------------------------------------

describe("connectionOwnerOptions", () => {
  it("lists Personal (user) first so the default owner is Personal", () => {
    const options = connectionOwnerOptions();
    expect(options[0]?.owner).toBe("user");
    expect(options[0]?.label).toBe("Personal");
    expect(options.map((option) => option.owner)).toEqual(["user", "org"]);
  });

  it("uses one Local/org option for non-org-scoped hosts", () => {
    const options = connectionOwnerOptionsForHost(null);
    expect(options.map((option) => [option.owner, option.label])).toEqual([["org", "Local"]]);
    expect(defaultConnectionOwnerForHost(null)).toBe("org");
  });

  it("keeps Personal as the default owner for org-scoped hosts", () => {
    expect(defaultConnectionOwnerForHost("org_123")).toBe("user");
  });
});

describe("normalizeConnectionOwner", () => {
  it("keeps a recognized owner", () => {
    const options = connectionOwnerOptions();
    expect(normalizeConnectionOwner("org", options)).toBe("org");
    expect(normalizeConnectionOwner("user", options)).toBe("user");
  });

  it("falls back to Personal (the first option) for an unrecognized owner", () => {
    const options = connectionOwnerOptions().filter((option) => option.owner === "user");
    // An owner not present in the (filtered) options falls back to options[0].
    expect(normalizeConnectionOwner("org", options)).toBe("user");
  });

  it("clamps old Personal handoffs to Local in non-org-scoped hosts", () => {
    const options = connectionOwnerOptionsForHost(null);
    expect(normalizeConnectionOwner("user", options)).toBe("org");
  });
});

describe("resolveConnectionOwnerForHost", () => {
  it("clamps every local connection create path to Local/org", () => {
    expect(resolveConnectionOwnerForHost(null, "user")).toBe("org");
    expect(resolveConnectionOwnerForHost(null, "org")).toBe("org");
  });

  it("keeps the requested owner in org-scoped hosts", () => {
    expect(resolveConnectionOwnerForHost("org_123", "user")).toBe("user");
    expect(resolveConnectionOwnerForHost("org_123", "org")).toBe("org");
  });
});

describe("resolveOAuthConnectionOwnerForHost", () => {
  it("clamps OAuth connections to Local/org on local hosts", () => {
    expect(
      resolveOAuthConnectionOwnerForHost({
        organizationId: null,
        requestedOwner: "user",
        clientOwner: "user",
      }),
    ).toBe("org");
    expect(
      resolveOAuthConnectionOwnerForHost({
        organizationId: null,
        requestedOwner: "user",
        clientOwner: "org",
      }),
    ).toBe("org");
  });

  it("keeps personal OAuth apps personal on cloud hosts", () => {
    expect(
      resolveOAuthConnectionOwnerForHost({
        organizationId: "org_123",
        requestedOwner: "org",
        clientOwner: "user",
      }),
    ).toBe("user");
  });

  it("lets shared OAuth apps mint either cloud owner", () => {
    expect(
      resolveOAuthConnectionOwnerForHost({
        organizationId: "org_123",
        requestedOwner: "user",
        clientOwner: "org",
      }),
    ).toBe("user");
    expect(
      resolveOAuthConnectionOwnerForHost({
        organizationId: "org_123",
        requestedOwner: "org",
        clientOwner: "org",
      }),
    ).toBe("org");
  });
});
