import { PagePending } from "@executor-js/hosted-web/page-pending";
import { PageError } from "@executor-js/hosted-web/route-fallbacks";
import { hostedServerValues } from "@executor-js/hosted-web/document";
import { dashboardRegistry } from "@executor-js/dashboard-start/registry";
import { createRouter } from "@tanstack/react-router";
import { serverDocument } from "./document.ts";
import { signInInitialValues } from "../contracts/auth.ts";
import { routeTree } from "./routeTree.gen.ts";

/** One router and atom registry per document request on the server, and one per page in the browser. */
export const getRouter = () => {
  const { connect, Wrap } = dashboardRegistry(
    import.meta.env.SSR
      ? [...hostedServerValues(serverDocument()), ...signInInitialValues(serverDocument().signIn)]
      : [],
  );
  return connect(
    createRouter({
      routeTree,
      defaultPreload: "intent",
      defaultPendingComponent: PagePending,
      defaultPendingMs: 100,
      defaultPendingMinMs: 0,
      defaultErrorComponent: PageError,
      scrollRestoration: true,
      scrollToTopSelectors: ["main"],
      Wrap,
    }),
  );
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
