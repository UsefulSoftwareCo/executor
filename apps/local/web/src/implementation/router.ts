import { createRouter, stringifySearchWith, type RouterHistory } from "@tanstack/react-router";
import { parseSearchParams, type NavigationSection } from "../contracts/navigation.ts";
import { routeTree } from "./routeTree.gen.ts";

/** Compose browser or test history with generated, automatically split SPA routes. */
export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: "intent",
    // Existing links use ordinary strings, including tool names such as "123".
    parseSearch: parseSearchParams,
    stringifySearch: stringifySearchWith(JSON.stringify),
    scrollRestoration: true,
    scrollToTopSelectors: ["main.main"],
  });
}

/** The router registered for typed links, route params and navigation. */
export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    section?: NavigationSection;
  }
}
