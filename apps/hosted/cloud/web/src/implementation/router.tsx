import { CloudPagePending } from "./components/page-pending.tsx";
import { PageError } from "@executor-js/hosted-web/route-fallbacks";
import { dashboardRegistry } from "@executor-js/dashboard-start/registry";
import { organizationRouteReads } from "@executor-js/hosted-web/organization";
import { createRouter } from "@tanstack/react-router";
import { cloudServerValues, serverDocument } from "./document.ts";
import { routeTree } from "./routeTree.gen.ts";
import { UIObservation } from "./ui-observation.tsx";

/** One router and atom registry per document request on the server, and one per page in the browser. */
export const getRouter = () => {
  const { connect, Wrap: Registry } = dashboardRegistry(
    import.meta.env.SSR ? cloudServerValues(serverDocument()) : [],
  );
  return connect(
    createRouter({
      routeTree,
      defaultPreload: "intent",
      defaultPendingComponent: CloudPagePending,
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      defaultErrorComponent: PageError,
      scrollRestoration: true,
      scrollToTopSelectors: ["main"],
      Wrap: ({ children }) => (
        <Registry>
          <UIObservation>{children}</UIObservation>
        </Registry>
      ),
    }),
    organizationRouteReads,
  );
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
