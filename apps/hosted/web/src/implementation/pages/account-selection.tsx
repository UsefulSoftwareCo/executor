import { Navigate } from "@tanstack/react-router";
import type { AppId, ProfileId } from "@executor-js/sdk";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Account management lives on the app; older setup links return to its Accounts tab. */
export function AccountSelectionPage({
  appId,
  profile,
}: {
  readonly appId: AppId;
  readonly profile?: ProfileId | undefined;
}) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <Navigate
      to="/org/$organizationSlug/apps/$appId"
      params={{ organizationSlug, appId }}
      search={{ view: "accounts", profile }}
      replace
    />
  );
}
