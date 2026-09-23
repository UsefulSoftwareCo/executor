import { ExecutorDevtools } from "@executor-js/devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { PageError, PageNotFound } from "@executor-js/hosted-web/route-fallbacks";
import { AuthBoundary } from "@executor-js/hosted-web/auth";
import { OrganizationResumeBoundary } from "@executor-js/hosted-web/organization";
import { useLocation } from "@tanstack/react-router";
import { hostedPageTitle } from "@executor-js/hosted-web/contracts/navigation";
import { DocumentTitleProvider, productTitle } from "@executor-js/ui/hooks/document-title";

/** Global auth, invitation and callback routes have no selected organization. */
export const Route = createRootRoute({
  component: Root,
  notFoundComponent: PageNotFound,
  errorComponent: PageError,
});

function Root() {
  const { pathname, searchStr } = useLocation();
  const devtoolsPath =
    pathname === "/login" ? (new URLSearchParams(searchStr).get("redirect") ?? pathname) : pathname;
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
      <ExecutorDevtools
        organization={devtoolsPath.startsWith("/org/") ? devtoolsPath.split(/[/?#]/)[2] : undefined}
      />
    </DocumentTitleProvider>
  );
}
