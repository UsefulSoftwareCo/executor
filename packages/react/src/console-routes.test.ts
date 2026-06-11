import { describe, expect, it } from "@effect/vitest";

import { CONSOLE_ROUTE_PATHS, consoleRoutes } from "./console-routes";
import { routeTree } from "./routes/routeTree.gen";

// consoleRoutes() (what apps mount) and routes/routeTree.gen.ts (what `bunx
// tsr generate` scans from src/routes, and what types this package's links)
// are two views of the same directory. If they drift — a route file added
// without a consoleRoutes() entry, or vice versa — apps would silently lack a
// route that this package's pages link to. Lock them together.

const collectPaths = (route: unknown): ReadonlyArray<string> => {
  const node = route as {
    options?: { id?: string };
    children?: ReadonlyArray<unknown>;
  };
  const children = node.children ?? [];
  const id = node.options?.id;
  const own = typeof id === "string" ? [id] : [];
  return [...own, ...children.flatMap(collectPaths)];
};

describe("console route contract", () => {
  it("consoleRoutes() declares exactly the routes in src/routes", () => {
    const generated = new Set(collectPaths(routeTree));
    expect([...generated].sort()).toEqual([...CONSOLE_ROUTE_PATHS].sort());
  });

  it("every path has a virtual route node and exclude removes it", () => {
    const all = consoleRoutes({ dir: "shared" });
    expect(all).toHaveLength(CONSOLE_ROUTE_PATHS.length);
    const withoutSecrets = consoleRoutes({ dir: "shared", exclude: ["/secrets"] });
    expect(withoutSecrets).toHaveLength(CONSOLE_ROUTE_PATHS.length - 1);
    expect(JSON.stringify(withoutSecrets)).not.toContain("secrets.tsx");
  });
});
