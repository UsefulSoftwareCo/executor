import { describe, expect, it } from "@effect/vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { CONSOLE_ROUTE_PATHS } from "../console-routes";
import { isAddAccountRequested } from "./integrations.$namespace";

// Routing semantics of the `/connect/<integration slug>` deep link — the URL a
// customer hands to an end user ("connect your Linear"). The page component is
// exercised end-to-end in e2e/scenarios/connect-deep-link.test.ts; this locks
// the URL contract itself: which shapes match, what the params resolve to, and
// that the org-slug prefix round-trips.

type RouteMatch = { readonly routeId: string; readonly params: Record<string, string> };
type SpikeRouter = {
  matchRoutes(pathname: string): ReadonlyArray<RouteMatch>;
  buildLocation(options: unknown): { readonly href: string };
};

const CONNECT_ROUTE_ID = "/{-$orgSlug}/connect/$integrationSlug";

const make = (): SpikeRouter => {
  const rootRoute = createRootRoute();
  const orgScope = createRoute({ getParentRoute: () => rootRoute, path: "/{-$orgSlug}" });
  const indexRoute = createRoute({ getParentRoute: () => orgScope, path: "/" });
  const connectRoute = createRoute({
    getParentRoute: () => orgScope,
    path: "/connect/$integrationSlug",
  });
  const nsRoute = createRoute({
    getParentRoute: () => orgScope,
    path: "/integrations/$namespace",
  });
  const routeTree = rootRoute.addChildren([
    orgScope.addChildren([indexRoute, connectRoute, nsRoute]),
  ]);
  // A test-local tree is not the package's registered console tree, so widen
  // away the global Register types — this asserts runtime semantics.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: a test-local route tree must escape the package-global router Register types
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  }) as unknown as SpikeRouter;
};

describe("connect deep link", () => {
  it("is part of the shared console route contract", () => {
    // Every host mounts the contract, so the deep link exists on cloud,
    // self-host, cloudflare and local alike.
    expect(CONSOLE_ROUTE_PATHS).toContain("/connect/$integrationSlug");
  });

  it("matches the bare link a customer would generate", () => {
    const matches = make().matchRoutes("/connect/linear");
    const match = matches.find((m) => m.routeId === CONNECT_ROUTE_ID);
    expect(match?.params).toEqual({ integrationSlug: "linear" });
  });

  it("matches the org-prefixed form without eating the slug", () => {
    const matches = make().matchRoutes("/acme/connect/linear");
    const match = matches.find((m) => m.routeId === CONNECT_ROUTE_ID);
    expect(match?.params).toEqual({ orgSlug: "acme", integrationSlug: "linear" });
  });

  it("keeps slugs that look like other console words intact", () => {
    // The integration slug is a free-form catalog id; "tools" or "integrations"
    // as a slug must still land on connect, not on those pages.
    for (const slug of ["tools", "integrations", "connect"]) {
      const match = make()
        .matchRoutes(`/connect/${slug}`)
        .find((m) => m.routeId === CONNECT_ROUTE_ID);
      expect(match?.params).toEqual({ integrationSlug: slug });
    }
  });

  it("builds the link with and without an org slug", () => {
    const router = make();
    expect(
      router.buildLocation({ to: CONNECT_ROUTE_ID, params: { integrationSlug: "linear" } }).href,
    ).toBe("/connect/linear");
    expect(
      router.buildLocation({
        to: CONNECT_ROUTE_ID,
        params: { orgSlug: "acme", integrationSlug: "linear" },
      }).href,
    ).toBe("/acme/connect/linear");
  });

  it("forwards into the integration's existing connect flow", () => {
    // The page redirects here rather than rendering its own connect UI; the
    // handoff is carried as validated search so it survives client navigation.
    // The number 1 keeps the canonical `?addAccount=1` that agent-generated
    // handoff links already use — a string would serialize as `%221%22`.
    const href = make().buildLocation({
      to: "/{-$orgSlug}/integrations/$namespace",
      params: { namespace: "linear" },
      search: { tab: "accounts", addAccount: 1 },
    }).href;
    expect(href).toBe("/integrations/linear?tab=accounts&addAccount=1");
  });
});

describe("addAccount flag", () => {
  it("accepts every spelling the two link sources produce", () => {
    // A full page load parses `?addAccount=1` to the number; a client-side
    // navigation may carry the string. Both mean "open the connect flow".
    expect(isAddAccountRequested(1)).toBe(true);
    expect(isAddAccountRequested("1")).toBe(true);
    expect(isAddAccountRequested(true)).toBe(true);
  });

  it("ignores anything else instead of failing the page", () => {
    for (const value of [undefined, null, 0, "0", "", "banana", {}]) {
      expect(isAddAccountRequested(value)).toBe(false);
    }
  });
});
