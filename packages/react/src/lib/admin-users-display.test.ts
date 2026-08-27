import { describe, expect, it } from "@effect/vitest";
import type { IntegrationSlug } from "@executor-js/sdk/shared";

import {
  adminAuditActorLabel,
  adminAuditResourceLabel,
  adminAuditScopeLabel,
  adminUserCopyableEmail,
  adminUserTitle,
  connectionHealthStatus,
  connectLinkUrl,
  formatLastSeen,
  integrationConnectionStates,
  isConnectableIntegration,
  isLocalSubject,
  lastSeenTitle,
  pageNumber,
  shortenExternalId,
  splitPage,
  type AdminCatalogRow,
  type AdminConnectionRow,
} from "./admin-users-display";

describe("audit activity display", () => {
  it("names actors without inventing an identity for system events", () => {
    expect(
      adminAuditActorLabel({
        actorId: "user_1",
        actorEmail: "admin@example.test",
        actorDisplayName: "Admin",
      }),
    ).toBe("admin@example.test");
    expect(adminAuditActorLabel({ actorId: null, actorEmail: null, actorDisplayName: null })).toBe(
      "System",
    );
  });

  it("renders safe resource identifiers and personal versus workspace scope", () => {
    expect(
      adminAuditResourceLabel({
        resourceType: "connection",
        resourceParent: "github",
        resourceId: "main",
      }),
    ).toBe("Connection: github / main");
    expect(
      adminAuditResourceLabel({
        resourceType: "oauth_client",
        resourceParent: null,
        resourceId: "workspace-app",
      }),
    ).toBe("OAuth app: workspace-app");
    expect(adminAuditScopeLabel("user")).toBe("Personal");
    expect(adminAuditScopeLabel("org")).toBe("Workspace");
    expect(adminAuditScopeLabel(null)).toBe("Workspace");
  });
});

const slug = (value: string): IntegrationSlug => value as IntegrationSlug;

/** A catalog row for a normal, connectable integration. `kind` is the owning
 *  plugin's key on a real row, so "openapi" is what the catalog actually says. */
const catalogRow = (value: string, kind = "openapi"): AdminCatalogRow => ({
  slug: slug(value),
  kind,
});

/** The built-in Executor row, exactly as a real catalog read returns it:
 *  `kind: "built-in"` with `authMethods: []` (verified against
 *  `executor.integrations.list()`). */
const builtInRow: AdminCatalogRow = { slug: slug("executor"), kind: "built-in" };

const connection = (overrides: Partial<AdminConnectionRow> = {}): AdminConnectionRow => ({
  owner: "user",
  integration: slug("acme"),
  name: "default",
  oauthScope: null,
  lastHealth: null,
  ...overrides,
});

describe("formatLastSeen", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);

  it("never seen reads as Never, not as a stale timestamp", () => {
    expect(formatLastSeen(null, now)).toBe("Never");
  });

  // The writer throttles lastSeenAt to ~1h, so anything inside that window is
  // one bucket. Reporting minutes would claim precision the field doesn't have.
  it("collapses everything inside the throttle window to one honest bucket", () => {
    expect(formatLastSeen(now - 60_000, now)).toBe("Within the hour");
    expect(formatLastSeen(now - 45 * 60_000, now)).toBe("Within the hour");
    expect(formatLastSeen(now, now)).toBe("Within the hour");
  });

  it("counts hours and days above the window, hedged with About", () => {
    expect(formatLastSeen(now - 60 * 60_000, now)).toBe("About 1 hour ago");
    expect(formatLastSeen(now - 5 * 60 * 60_000, now)).toBe("About 5 hours ago");
    expect(formatLastSeen(now - 24 * 60 * 60_000, now)).toBe("About 1 day ago");
    expect(formatLastSeen(now - 9 * 24 * 60 * 60_000, now)).toBe("About 9 days ago");
  });

  it("falls back to an absolute date once relative wording stops being useful", () => {
    expect(formatLastSeen(now - 200 * 24 * 60 * 60_000, now)).not.toContain("ago");
  });

  it("the tooltip carries the exact instant and the coarseness caveat", () => {
    expect(lastSeenTitle(null)).toBe("Never seen on a request");
    expect(lastSeenTitle(now)).toContain("at most once an hour");
  });
});

describe("externalId display", () => {
  it("recognizes the single-player host sentinel", () => {
    expect(isLocalSubject("local")).toBe(true);
    expect(isLocalSubject("user_01JABCDEF")).toBe(false);
  });

  it("leaves short ids exactly as the server sent them", () => {
    expect(shortenExternalId("user_01JAB")).toBe("user_01JAB");
  });

  // Truncation is visual only — the id is opaque, so both ends are kept and two
  // ids differing in the middle stay distinguishable.
  it("shortens long ids from the middle, keeping both ends", () => {
    const long = "user_01JABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const short = shortenExternalId(long, 21);
    expect(short.length).toBe(21);
    expect(short.startsWith("user_01JAB")).toBe(true);
    expect(short.endsWith("0123456789")).toBe(true);
    expect(short).toContain("…");
  });
});

describe("adminUserTitle", () => {
  // The email is what an operator invites, searches and supports against, so it
  // leads — and the opaque id drops to the supporting line rather than vanishing.
  it("leads with the email and keeps the id as the supporting line", () => {
    expect(
      adminUserTitle({ externalId: "user_01JAB", email: "ada@e2e.test", displayName: "Ada L" }),
    ).toEqual({ primary: "ada@e2e.test", secondary: "user_01JAB", primaryIsId: false });
  });

  it("falls back to the display name when the host resolved no email", () => {
    expect(adminUserTitle({ externalId: "user_01JAB", email: null, displayName: "Ada L" })).toEqual(
      { primary: "Ada L", secondary: "user_01JAB", primaryIsId: false },
    );
  });

  // The pre-identity rendering, unchanged: one mono id line and no subtitle. A
  // row the host cannot name must not degrade to a gap where a name would be.
  it("renders exactly the old id-only row when the host resolved neither", () => {
    expect(adminUserTitle({ externalId: "user_01JAB", email: null, displayName: null })).toEqual({
      primary: "user_01JAB",
      secondary: null,
      primaryIsId: true,
    });
  });

  // A member who left the org while their connections remain arrives with the
  // fields simply missing rather than explicitly null.
  it("treats missing identity fields the same as null ones", () => {
    expect(adminUserTitle({ externalId: "user_01JAB" }).primaryIsId).toBe(true);
  });

  // A directory that stores empty strings must not produce a blank headline.
  it("does not let a blank email or name become the headline", () => {
    expect(adminUserTitle({ externalId: "user_01JAB", email: "  ", displayName: "" })).toEqual({
      primary: "user_01JAB",
      secondary: null,
      primaryIsId: true,
    });
  });

  it("spells out the single-player host sentinel, which names no member", () => {
    expect(adminUserTitle({ externalId: "local", email: null, displayName: null })).toEqual({
      primary: "local",
      secondary: null,
      primaryIsId: true,
    });
  });
});

describe("adminUserCopyableEmail", () => {
  it("offers the email when the host resolved one", () => {
    expect(adminUserCopyableEmail({ externalId: "user_01JAB", email: "ada@e2e.test" })).toBe(
      "ada@e2e.test",
    );
  });

  // A name is not an address: a copy button that yields something unusable is
  // worse than no button, so a name-only row offers nothing to copy.
  it("offers nothing when only a display name is known", () => {
    expect(
      adminUserCopyableEmail({ externalId: "user_01JAB", email: null, displayName: "Ada L" }),
    ).toBeNull();
  });

  it("treats a blank email as absent", () => {
    expect(adminUserCopyableEmail({ externalId: "user_01JAB", email: "   " })).toBeNull();
  });
});

describe("connectionHealthStatus", () => {
  it("reads the stored verdict", () => {
    expect(connectionHealthStatus(connection({ lastHealth: { status: "expired" } }))).toBe(
      "expired",
    );
  });

  it("a never-probed connection is unchecked, not healthy", () => {
    expect(connectionHealthStatus(connection({ lastHealth: null }))).toBe("unknown");
  });
});

describe("isConnectableIntegration", () => {
  it("a built-in integration has no connect flow to send anyone to", () => {
    expect(isConnectableIntegration(builtInRow)).toBe(false);
    // The product page pins the reserved slug as well as the kind
    // (`integration-detail.tsx`), so both spellings are refused.
    expect(isConnectableIntegration({ slug: slug("executor"), kind: "openapi" })).toBe(false);
  });

  // The trap: an openapi/mcp/graphql integration can carry `authMethods: []`
  // and STILL be connectable, because its accounts panel supplies
  // `createCustomMethod`. Empty auth methods must never be read as "no connect
  // flow" — only `built-in` means that.
  it("a normal integration stays connectable regardless of declared auth methods", () => {
    expect(isConnectableIntegration(catalogRow("acme"))).toBe(true);
    expect(isConnectableIntegration(catalogRow("beta", "mcp"))).toBe(true);
    expect(isConnectableIntegration(catalogRow("gamma", "graphql"))).toBe(true);
  });
});

describe("integrationConnectionStates", () => {
  it("shows the whole catalog, marking what this user has connected", () => {
    const states = integrationConnectionStates(
      [catalogRow("acme"), catalogRow("beta"), catalogRow("gamma")],
      [connection({ integration: slug("beta") })],
    );
    expect(states.map((state) => state.integration)).toEqual(["beta", "acme", "gamma"]);
    expect(states.map((state) => state.connected)).toEqual([true, false, false]);
  });

  it("keeps an available integration listed even when nobody connected it", () => {
    const states = integrationConnectionStates([catalogRow("acme")], []);
    expect(states).toEqual([{ integration: "acme", connected: false, connections: [] }]);
  });

  // The reported bug: the built-in Executor integration appeared under "not
  // connected" with a copyable link to a flow that does not exist. It is not a
  // slot, not a denominator, and not a link.
  it("drops a non-connectable integration from the view and the counts entirely", () => {
    const states = integrationConnectionStates(
      [catalogRow("acme"), builtInRow],
      [connection({ integration: slug("acme") })],
    );
    expect(states.map((state) => state.integration)).toEqual(["acme"]);
  });

  it("a catalog of nothing but non-connectable integrations yields no slots at all", () => {
    expect(integrationConnectionStates([builtInRow], [])).toEqual([]);
  });

  // Data honesty beats the filter: if a user somehow HOLDS a connection on a
  // non-connectable integration, hiding it would misreport what they have.
  it("still reports a held connection on a non-connectable integration, as connected", () => {
    const states = integrationConnectionStates(
      [catalogRow("acme"), builtInRow],
      [connection({ integration: slug("executor"), name: "coreTools" })],
    );
    expect(states.map((state) => state.integration)).toEqual(["executor", "acme"]);
    expect(states.map((state) => state.connected)).toEqual([true, false]);
  });

  // Dropping the user's own credential because the catalog read missed it would
  // under-report what they actually hold.
  it("still reports a connection whose integration is missing from the catalog", () => {
    const states = integrationConnectionStates([], [connection({ integration: slug("ghost") })]);
    expect(states.map((state) => state.integration)).toEqual(["ghost"]);
    expect(states[0]?.connected).toBe(true);
  });

  it("groups every connection a user holds on one integration", () => {
    const states = integrationConnectionStates(
      [catalogRow("acme")],
      [
        connection({ integration: slug("acme"), name: "work" }),
        connection({ integration: slug("acme"), name: "personal" }),
      ],
    );
    expect(states[0]?.connections.map((row) => row.name)).toEqual(["work", "personal"]);
  });

  it("orders connected first, then alphabetically, so the order is stable per user", () => {
    const states = integrationConnectionStates(
      [catalogRow("zulu"), catalogRow("alpha"), catalogRow("mike")],
      [connection({ integration: slug("zulu") })],
    );
    expect(states.map((state) => state.integration)).toEqual(["zulu", "alpha", "mike"]);
  });
});

describe("connectLinkUrl", () => {
  // The org segment is the SENDING admin's. A recipient in several orgs would
  // otherwise land in whichever their session defaults to and connect the
  // credential in the wrong workspace — succeeding, silently, in the wrong place.
  it("carries the sending admin's org so a multi-org recipient lands in the right one", () => {
    expect(connectLinkUrl(slug("acme"), "https://console.example.com", "north-wind")).toBe(
      "https://console.example.com/north-wind/connect/acme",
    );
  });

  // Self-host and local have no orgs, so there is no segment to carry and the
  // bare form is the whole route.
  it("builds the bare form on a host with no org slug", () => {
    expect(connectLinkUrl(slug("acme"), "https://console.example.com")).toBe(
      "https://console.example.com/connect/acme",
    );
    expect(connectLinkUrl(slug("acme"), "https://console.example.com", undefined)).toBe(
      "https://console.example.com/connect/acme",
    );
    // An empty or whitespace slug is absence, not an empty path segment — it
    // must never render "//connect/acme".
    expect(connectLinkUrl(slug("acme"), "https://console.example.com", "")).toBe(
      "https://console.example.com/connect/acme",
    );
    expect(connectLinkUrl(slug("acme"), "https://console.example.com", "  ")).toBe(
      "https://console.example.com/connect/acme",
    );
  });

  it("does not double the separator when the origin carries a trailing slash", () => {
    expect(connectLinkUrl(slug("acme"), "https://console.example.com/")).toBe(
      "https://console.example.com/connect/acme",
    );
    expect(connectLinkUrl(slug("acme"), "https://console.example.com/", "north-wind")).toBe(
      "https://console.example.com/north-wind/connect/acme",
    );
  });
});

describe("paging", () => {
  // The contract returns no total, so the page over-fetches by one row and the
  // extra row IS the answer to "is there a next page".
  it("an over-fetched page yields the page's rows plus a next-page signal", () => {
    expect(splitPage([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], hasNext: true });
  });

  it("a page that came back short is the last page", () => {
    expect(splitPage([1, 2], 3)).toEqual({ rows: [1, 2], hasNext: false });
  });

  it("an exactly-full page without the extra row is also the last page", () => {
    expect(splitPage([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], hasNext: false });
  });

  it("numbers pages from one", () => {
    expect(pageNumber(0, 25)).toBe(1);
    expect(pageNumber(25, 25)).toBe(2);
    expect(pageNumber(75, 25)).toBe(4);
  });
});
