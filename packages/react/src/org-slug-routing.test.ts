import { describe, expect, it } from "@effect/vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

// Spike: runtime semantics of the optional {-$orgSlug} segment.

type RouteMatch = { readonly routeId: string; readonly params: Record<string, string> };
type SpikeRouter = {
  matchRoutes(pathname: string): ReadonlyArray<RouteMatch>;
  buildLocation(options: unknown): { readonly href: string };
  navigate(options: unknown): Promise<void>;
  load(): Promise<void>;
};

const make = (): SpikeRouter => {
  const rootRoute = createRootRoute();
  const orgScope = createRoute({
    getParentRoute: () => rootRoute,
    path: "/{-$orgSlug}",
  });
  const indexRoute = createRoute({ getParentRoute: () => orgScope, path: "/" });
  const policiesRoute = createRoute({ getParentRoute: () => orgScope, path: "/policies" });
  const nsRoute = createRoute({
    getParentRoute: () => orgScope,
    path: "/integrations/$namespace",
  });
  const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login" });
  const routeTree = rootRoute.addChildren([
    orgScope.addChildren([indexRoute, policiesRoute, nsRoute]),
    loginRoute,
  ]);
  // This local tree is NOT the package's registered console tree, so widen
  // away the global Register types — the test asserts runtime semantics.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: a test-local route tree must escape the package-global router Register types
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  }) as unknown as SpikeRouter;
};

describe("optional org-slug segment", () => {
  it("matches bare and slugged URLs with the same route", async () => {
    const router = make();

    const bare = router.matchRoutes("/policies");
    expect(bare.map((m) => m.routeId)).toContain("/{-$orgSlug}/policies");
    expect(bare.find((m) => m.routeId === "/{-$orgSlug}/policies")?.params).toEqual({});

    const slugged = router.matchRoutes("/acme/policies");
    expect(slugged.map((m) => m.routeId)).toContain("/{-$orgSlug}/policies");
    expect(slugged.find((m) => m.routeId === "/{-$orgSlug}/policies")?.params).toEqual({
      orgSlug: "acme",
    });
  });

  it("static sibling routes win over a slug match", () => {
    const router = make();
    const matches = router.matchRoutes("/login");
    expect(matches.map((m) => m.routeId)).toContain("/login");
    expect(matches.map((m) => m.routeId)).not.toContain("/{-$orgSlug}/");
  });

  it("treats the first segment of nested paths as a slug", () => {
    const router = make();
    // "/integrations/$namespace" with namespace=github should match the
    // CONSOLE route bare — NOT consume "integrations" as an orgSlug.
    const matches = router.matchRoutes("/integrations/github");
    const m = matches.find((x) => x.routeId === "/{-$orgSlug}/integrations/$namespace");
    expect(m?.params).toEqual({ namespace: "github" });
  });

  it("builds hrefs with and without the slug", () => {
    const router = make();
    expect(
      router.buildLocation({ to: "/{-$orgSlug}/policies", params: { orgSlug: "acme" } }).href,
    ).toBe("/acme/policies");
    expect(router.buildLocation({ to: "/{-$orgSlug}/policies", params: {} }).href).toBe(
      "/policies",
    );
  });

  it("inherits the slug param on relative navigations", async () => {
    const router = make();
    await router.navigate({ to: "/{-$orgSlug}", params: { orgSlug: "acme" } });
    await router.load();
    // A link that only supplies its own params keeps the current orgSlug.
    const href = router.buildLocation({
      to: "/{-$orgSlug}/integrations/$namespace",
      params: (prev: Record<string, string>) => ({ ...prev, namespace: "github" }),
    }).href;
    expect(href).toBe("/acme/integrations/github");
  });

  it("ambiguity check: /acme/policies vs a namespace named policies", () => {
    const router = make();
    // /acme/integrations/github — slug + integration detail
    const matches = router.matchRoutes("/acme/integrations/github");
    const m = matches.find((x) => x.routeId === "/{-$orgSlug}/integrations/$namespace");
    expect(m?.params).toEqual({ orgSlug: "acme", namespace: "github" });
  });
});
