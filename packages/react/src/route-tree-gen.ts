import { Generator, getConfig } from "@tanstack/router-generator";
import type { VirtualRootRoute } from "@tanstack/virtual-file-routes";

// ---------------------------------------------------------------------------
// Programmatic routeTree.gen.ts generation — the same generator the TanStack
// vite plugins run during dev/build, callable from each app's `routes:gen`
// script with the app's own tsr.routes.ts. One code path so a CLI regen and a
// dev-server run can never produce different trees.
// ---------------------------------------------------------------------------

export interface RouteTreeGenTarget {
  /** The app/package root the generator resolves from. */
  readonly root: string;
  readonly routesDirectory: string;
  readonly generatedRouteTree: string;
  readonly virtualRouteConfig: VirtualRootRoute;
  /** Extra lines appended to the generated file (cloud's Start Register block). */
  readonly routeTreeFileFooter?: ReadonlyArray<string>;
}

export const generateRouteTree = async (target: RouteTreeGenTarget): Promise<void> => {
  const config = getConfig(
    {
      routesDirectory: target.routesDirectory,
      generatedRouteTree: target.generatedRouteTree,
      virtualRouteConfig: target.virtualRouteConfig,
      ...(target.routeTreeFileFooter
        ? { routeTreeFileFooter: [...target.routeTreeFileFooter] }
        : {}),
      target: "react",
    },
    target.root,
  );
  await new Generator({ config, root: target.root }).run();
};
