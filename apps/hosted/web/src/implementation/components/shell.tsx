import type { ReactNode } from "react";
import { OrganizationSwitcher, useOrganizationRoute } from "./organization.tsx";
import { DashboardFrame } from "./dashboard-frame.tsx";

/** Organization and session controls belong to the hosted product, outside the shared shell. */
export function DashboardShell({
  navigation,
  banner,
  children,
  allowCreateOrganization = true,
}: {
  readonly navigation: ReactNode;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
  readonly allowCreateOrganization?: boolean;
}) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <DashboardFrame
      organizationSlug={organizationSlug}
      organization={<OrganizationSwitcher allowCreate={allowCreateOrganization} />}
      navigation={navigation}
      banner={banner}
    >
      {children}
    </DashboardFrame>
  );
}
