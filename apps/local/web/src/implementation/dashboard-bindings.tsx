import { parseAppSearch } from "../contracts/navigation.ts";
import { DashboardProvider } from "@executor-js/ui/dashboard/context";
import type { AppLinkProps, AccountLinkProps } from "@executor-js/ui/contracts/dashboard";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { dashboardAtoms } from "../contracts/dashboard-bindings.ts";
import { catalogIconDomainsAtom } from "@executor-js/ui/contracts/icons";

const iconDomains = catalogIconDomainsAtom(dashboardAtoms.catalog);

const AppLink = ({ app, view, tool, profile, ...props }: AppLinkProps) => {
  const location = useRouterState({ select: (state) => state.location });
  const current =
    location.pathname === `/apps/${encodeURIComponent(app)}`
      ? parseAppSearch(location.search).profile
      : undefined;
  return (
    <Link
      to="/apps/$appId"
      params={{ appId: app }}
      search={{ view, tool, profile: profile ?? current }}
      {...props}
    />
  );
};
const AccountLink = ({ account, ...props }: AccountLinkProps) => (
  <Link to="/accounts/$accountId" params={{ accountId: account }} {...props} />
);
/** Typed navigation and local data are supplied outside the shared UI. */
export function LocalDashboard({ children }: { readonly children: ReactNode }) {
  return (
    <DashboardProvider iconDomains={iconDomains} AppLink={AppLink} AccountLink={AccountLink}>
      {children}
    </DashboardProvider>
  );
}
