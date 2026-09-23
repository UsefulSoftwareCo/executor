import { ErrorReportingIdentity } from "../error-reporting.tsx";
import { AnalyticsIdentity } from "../analytics.tsx";
import { ExecutorDevtools } from "@executor-js/devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { PageError, PageNotFound } from "@executor-js/hosted-web/route-fallbacks";
import { AuthBoundary } from "@executor-js/hosted-web/auth";
import { OrganizationResumeBoundary } from "@executor-js/hosted-web/organization";
import { TeamSetupBoundary } from "../components/team-setup.tsx";
import { useLocation } from "@tanstack/react-router";
import { hostedPageTitle } from "@executor-js/hosted-web/contracts/navigation";
import { DocumentTitleProvider, productTitle } from "@executor-js/ui/hooks/document-title";

/** Global auth, invitation and callback routes have no selected organization. */
export const Route = createRootRoute({
  component: () => <Root />,
  notFoundComponent: PageNotFound,
  errorComponent: PageError,
});

function Root() {
  const { pathname, searchStr } = useLocation();
  const ssoSignIn = pathname === "/login/sso";
  const devtoolsPath =
    pathname === "/login" || ssoSignIn
      ? (new URLSearchParams(searchStr).get("redirect") ?? pathname)
      : pathname;
  if (pathname === "/email/unsubscribe" || pathname === "/email/unsubscribe/")
    return (
      <DocumentTitleProvider fallbackTitle={productTitle("Email preferences")}>
        <Outlet />
      </DocumentTitleProvider>
    );
  return (
    <DocumentTitleProvider
      fallbackTitle={productTitle(
        pathname === "/create/agent"
          ? "Continue in your agent"
          : pathname === "/create"
            ? "Create your team"
            : hostedPageTitle(pathname, { billing: "Billing" }),
      )}
    >
      <AnalyticsIdentity />
      <ErrorReportingIdentity />
      {ssoSignIn ? (
        <Outlet />
      ) : (
        <AuthBoundary>
          <OrganizationResumeBoundary>
            <TeamSetupBoundary>
              <Outlet />
            </TeamSetupBoundary>
          </OrganizationResumeBoundary>
        </AuthBoundary>
      )}
      <ExecutorDevtools
        organization={devtoolsPath.startsWith("/org/") ? devtoolsPath.split(/[/?#]/)[2] : undefined}
      />
    </DocumentTitleProvider>
  );
}
