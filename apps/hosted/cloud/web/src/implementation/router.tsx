import { CloudPagePending } from "./components/page-pending.tsx";
import { PageError } from "@executor-js/hosted-web/route-fallbacks";
import { dashboardRegistry } from "@executor-js/dashboard-start/registry";
import { createRouter } from "@tanstack/react-router";
import { cloudServerValues, serverDocument } from "./document.ts";
import { routeTree } from "./routeTree.gen.ts";
import { UIObservation } from "./ui-observation.tsx";

export const getRouter = () => {
  const { connect, Wrap: Registry } = dashboardRegistry(
    import.meta.env.SSR ? cloudServerValues(serverDocument()) : [],
  );
  return connect(
    createRouter({
      routeTree,
      defaultPreload: "intent",
      defaultPendingComponent: CloudPagePending,
      defaultPendingMs: 100,
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
  );
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
