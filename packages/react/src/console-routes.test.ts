import { describe, expect, it } from "@effect/vitest";

import { CONSOLE_ROUTE_PATHS, ORG_SLUG_SEGMENT, consoleRoutes } from "./console-routes";
import { routeTree } from "./routes/routeTree.gen";

// consoleRoutes() (what apps mount) and routes/routeTree.gen.ts (what `bunx
// tsr generate` builds from tsr.routes.ts, and what types this package's
// links) are two views of the same contract. If they drift — a route file
// added without a consoleRoutes() entry, or vice versa — apps would silently
// lack a route that this package's pages link to. Lock them together.

const collectPaths = (route: unknown, parentId = ""): ReadonlyArray<string> => {
  const node = route as {
    options?: { id?: string };
    children?: ReadonlyArray<unknown>;
  };
  const children = node.children ?? [];
  const id = node.options?.id;
  const resolved =
    typeof id === "string"
      ? parentId && !id.startsWith(`/${ORG_SLUG_SEGMENT}`)
        ? `${parentId.replace(/\/$/, "")}${id}`
        : id
      : parentId;
  const own = typeof id === "string" ? [resolved] : [];
  return [...own, ...children.flatMap((child) => collectPaths(child, resolved))];
};

// The generated ids are the scope-relative contract paths nested under the
// optional org-slug segment ("/policies" -> "/{-$orgSlug}/policies").
const scopedId = (path: string): string =>
  path === "/" ? `/${ORG_SLUG_SEGMENT}/` : `/${ORG_SLUG_SEGMENT}${path}`;

describe("console route contract", () => {
  it("the generated tree is exactly CONSOLE_ROUTE_PATHS under the org scope", () => {
    // The scope node itself is file-less, so the generator flattens it — the
    // tree contains only the scoped leaf ids.
    const generated = new Set(collectPaths(routeTree));
    const expected = CONSOLE_ROUTE_PATHS.map(scopedId);
    expect([...generated].sort()).toEqual(expected.sort());
  });

  it("every path has a virtual route node and exclude removes it", () => {
    const [scope] = consoleRoutes({ dir: "shared" });
    expect(scope).toMatchObject({ type: "route", path: `/${ORG_SLUG_SEGMENT}` });
    const children = (scope as { children?: ReadonlyArray<unknown> }).children ?? [];
    expect(children).toHaveLength(CONSOLE_ROUTE_PATHS.length);

    const [withoutSecrets] = consoleRoutes({ dir: "shared", exclude: ["/secrets"] });
    const remaining = (withoutSecrets as { children?: ReadonlyArray<unknown> }).children ?? [];
    expect(remaining).toHaveLength(CONSOLE_ROUTE_PATHS.length - 1);
    expect(JSON.stringify(withoutSecrets)).not.toContain("secrets.tsx");
  });

  it("orgScoped extras mount inside the org scope", () => {
    const [scope] = consoleRoutes({
      dir: "shared",
      orgScoped: [{ type: "route", path: "/billing", file: "app/billing.tsx" }],
    });
    expect(JSON.stringify(scope)).toContain("/billing");
  });
});
