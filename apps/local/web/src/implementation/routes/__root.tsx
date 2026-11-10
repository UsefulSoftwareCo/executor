import { ExecutorDevtools } from "@executor-js/devtools";
import { ClientOnly, createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useAtomSet } from "@effect/atom-react";
import { useEffect } from "react";
import { connectionEntryAtom } from "../../contracts/account-connections.ts";
import { pairingTokenAtom } from "../../contracts/connection.ts";
import { oauthCallbackAtom } from "../../contracts/oauth.ts";
import type { BrowserEntryValues } from "../router.tsx";
import { localPageTitle } from "../../contracts/navigation.ts";
import { NotFoundPage } from "../components/not-found.tsx";
import { useLocation } from "@tanstack/react-router";
import { DocumentTitleProvider } from "@executor-js/ui/hooks/document-title";
import { DashboardDocument } from "@executor-js/dashboard-start/shell";
import styles from "../styles/globals.css?url";
import { fontPreloads } from "@executor-js/ui/lib/fonts";

/** Standalone connection handoffs and authenticated dashboard routes share only the router. */
export const Route = createRootRouteWithContext<{
  readonly entry: BrowserEntryValues | undefined;
}>()({
  head: () => ({
    links: [...fontPreloads, { rel: "stylesheet", href: styles }],
    meta: [{ title: "Executor · Local" }],
  }),
  shellComponent: DashboardDocument,
  component: Root,
  notFoundComponent: NotFoundPage,
});

function Root() {
  const { pathname } = useLocation();
  return (
    <DocumentTitleProvider fallbackTitle={localPageTitle(pathname)}>
      <BrowserEntry />
      <Outlet />
      {/* A development overlay; it reads the browser origin and has no server markup. */}
      <ClientOnly>
        <ExecutorDevtools />
      </ClientOnly>
    </DocumentTitleProvider>
  );
}

/**
 * Apply the entry credentials the browser erased from its address. The server rendered without
 * them, so they take effect after hydration instead of changing the first render.
 */
function BrowserEntry() {
  const { entry } = Route.useRouteContext();
  const setPairingToken = useAtomSet(pairingTokenAtom);
  const setOAuthCallback = useAtomSet(oauthCallbackAtom);
  const setConnection = useAtomSet(connectionEntryAtom);
  useEffect(() => {
    if (entry === undefined) return;
    if (entry.pairingToken !== undefined) setPairingToken(entry.pairingToken);
    if (entry.oauthCallback !== undefined) setOAuthCallback(entry.oauthCallback);
    if (entry.connection !== undefined) setConnection(entry.connection);
  }, [entry, setPairingToken, setOAuthCallback, setConnection]);
  return null;
}
