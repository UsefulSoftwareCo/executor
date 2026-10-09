import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { clearSessionDisplay, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { ExecutorDevtools } from "@executor-js/devtools";
import { ClientOnly, createRootRoute, Outlet } from "@tanstack/react-router";
import { PageError, PageNotFound } from "@executor-js/hosted-web/route-fallbacks";
import { AuthBoundary } from "@executor-js/hosted-web/auth";
import { OrganizationResumeBoundary } from "@executor-js/hosted-web/organization";
import { useLocation } from "@tanstack/react-router";
import { hostedPageTitle } from "@executor-js/hosted-web/contracts/navigation";
import { DocumentTitleProvider, productTitle } from "@executor-js/ui/hooks/document-title";
import { DashboardDocument } from "@executor-js/dashboard-start/shell";
import styles from "@executor-js/hosted-web/styles?url";
import { requireSession, restoreLastOrganization } from "@executor-js/hosted-web/document";
import { serverDocument } from "../document.ts";

/** Global auth, invitation and callback routes have no selected organization. */
export const Route = createRootRoute({
  head: () => ({ links: [{ rel: "stylesheet", href: styles }], meta: [{ title: "Executor" }] }),
  shellComponent: DashboardDocument,
  // Sign-in is decided before any HTML; the browser's session check only revalidates.
  beforeLoad: async ({ location }) => {
    if (!import.meta.env.SSR) return;
    requireSession(serverDocument(), location.pathname, ["/login"]);
    await restoreLastOrganization(serverDocument(), location.pathname);
  },
  component: Root,
  notFoundComponent: PageNotFound,
  errorComponent: PageError,
});

function Root() {
  const session = useAtomValue(sessionAtom);
  const { pathname } = useLocation();
  return (
    <DocumentTitleProvider
      fallbackTitle={productTitle(
        pathname === "/setup/agent" ? "Continue in your agent" : hostedPageTitle(pathname),
      )}
    >
      <AuthBoundary>
        <OrganizationResumeBoundary>
          <Outlet />
        </OrganizationResumeBoundary>
      </AuthBoundary>
      {/* A development overlay; it reads the browser origin and has no server markup. */}
      <ClientOnly>
        <ExecutorDevtools
          onSessionChange={clearSessionDisplay}
          identity={AsyncResult.isSuccess(session) && !session.waiting ? session.value : null}
        />
      </ClientOnly>
    </DocumentTitleProvider>
  );
}
