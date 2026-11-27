import { documentValues } from "@executor-js/dashboard-start/api";
import { dashboardRegistry } from "@executor-js/dashboard-start/registry";
import { Effect } from "effect";
import { createRouter, stringifySearchWith } from "@tanstack/react-router";
import { parseSearchParams, type NavigationSection } from "../contracts/navigation.ts";
import { readAccountConnection } from "./account-connections.ts";
import { readPairingToken } from "./connection.ts";
import { readOAuthCallback } from "./oauth.ts";
import { routeTree } from "./routeTree.gen.ts";
import { serverDocument } from "./document.ts";

const readBrowserEntry = () => ({
  pairingToken: Effect.runSync(readPairingToken),
  connection: Effect.runSync(readAccountConnection),
  oauthCallback: Effect.runSync(readOAuthCallback),
});
export type BrowserEntryValues = ReturnType<typeof readBrowserEntry>;

export function getRouter() {
  const { connect, Wrap } = dashboardRegistry(
    import.meta.env.SSR ? documentValues(serverDocument()) : [],
  );
  const entry = import.meta.env.SSR ? undefined : readBrowserEntry();
  return connect(
    createRouter({
      routeTree,
      context: { entry },
      defaultPreload: "intent",
      parseSearch: parseSearchParams,
      stringifySearch: stringifySearchWith(JSON.stringify),
      scrollRestoration: true,
      scrollToTopSelectors: ["main.main"],
      Wrap,
    }),
  );
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    section?: NavigationSection;
  }
}
