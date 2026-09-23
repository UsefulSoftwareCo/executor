import { useOrganizationRoute } from "./organization.tsx";
import { DashboardNavigation } from "./dashboard-frame.tsx";

/** Common links that hosts compose with their own navigation. */
export function HostedNavigation() {
  const { slug, role } = useOrganizationRoute();
  return <DashboardNavigation organization={{ slug, role }} />;
}
