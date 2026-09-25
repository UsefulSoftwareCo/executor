import { CloudPagePending } from "./components/page-pending.tsx";
import { PageError } from "@executor-js/hosted-web/route-fallbacks";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

/** Browser-only navigation with generated routes and split page bundles. */
export const createDashboardRouter = () =>
  createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPendingComponent: CloudPagePending,
    defaultPendingMs: 100,
    defaultPendingMinMs: 0,
    defaultErrorComponent: PageError,
    scrollRestoration: true,
    scrollToTopSelectors: ["main"],
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}
