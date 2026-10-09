import type { ReactNode } from "react";
import { useOrganizationRoute } from "./organization.tsx";
import { DashboardNavigation } from "./dashboard-frame.tsx";

/** Common links followed by the host's own organization pages. */
export function HostedNavigation({ children }: { readonly children?: ReactNode }) {
  const { slug, role } = useOrganizationRoute();
  return <DashboardNavigation organization={{ slug, role }}>{children}</DashboardNavigation>;
}
