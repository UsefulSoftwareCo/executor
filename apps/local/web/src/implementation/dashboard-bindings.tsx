import { DashboardProvider } from "@executor-js/ui/dashboard/context";
import type { AppLinkProps, AccountLinkProps } from "@executor-js/ui/contracts/dashboard";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { dashboardAtoms } from "../contracts/dashboard-bindings.ts";
import { catalogIconsAtom } from "@executor-js/ui/contracts/icons";

const catalogIcons = catalogIconsAtom(dashboardAtoms.catalog);

const AppLink = ({ app, view, tool, ...props }: AppLinkProps) => (
  <Link to="/apps/$appId" params={{ appId: app }} search={{ view, tool }} {...props} />
);
const AccountLink = ({ account, ...props }: AccountLinkProps) => (
  <Link to="/accounts" search={{ account }} {...props} />
);
/** Typed navigation and local data are supplied outside the shared UI. */
export function LocalDashboard({ children }: { readonly children: ReactNode }) {
  return (
    <DashboardProvider catalogIcons={catalogIcons} AppLink={AppLink} AccountLink={AccountLink}>
      {children}
    </DashboardProvider>
  );
}
