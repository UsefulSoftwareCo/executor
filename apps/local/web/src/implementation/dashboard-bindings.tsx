import type { App } from "@executor-js/sdk";
import { DashboardProvider } from "@executor-js/ui/dashboard/context";
import type { AppLinkProps, AccountLinkProps } from "@executor-js/ui/contracts/dashboard";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { dashboardAtoms } from "../contracts/dashboard-bindings.ts";
import { catalogIconsAtom } from "@executor-js/ui/contracts/icons";

const catalogIcons = catalogIconsAtom(dashboardAtoms.catalog);

const appIconUrl = (app: App) =>
  `/dashboard/api/apps/${encodeURIComponent(app.id)}/icon?version=${encodeURIComponent(app.activeVersion ?? "")}`;

const AppLink = ({ app, view, tool, ...props }: AppLinkProps) => (
  <Link to="/apps/$appId" params={{ appId: app }} search={{ view, tool }} {...props} />
);
const AccountLink = ({ account, ...props }: AccountLinkProps) => (
  <Link to="/accounts" search={{ account }} {...props} />
);
export function LocalDashboard({ children }: { readonly children: ReactNode }) {
  return (
    <DashboardProvider
      catalogIcons={catalogIcons}
      AppLink={AppLink}
      AccountLink={AccountLink}
      appIconUrl={appIconUrl}
    >
      {children}
    </DashboardProvider>
  );
}
