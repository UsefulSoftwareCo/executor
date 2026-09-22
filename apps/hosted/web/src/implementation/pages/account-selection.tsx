import { Navigate } from "@tanstack/react-router";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Setup links enter the app's account controls without a second selection page. */
export function AccountSelectionPage({ appId }: { readonly appId: string }) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <Navigate
      to="/org/$organizationSlug/apps/$appId"
      params={{ organizationSlug, appId }}
      search={{ view: "accounts" }}
      replace
    />
  );
}
