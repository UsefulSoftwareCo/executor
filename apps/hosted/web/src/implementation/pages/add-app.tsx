import { useAtomMount } from "@effect/atom-react";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { Link } from "@tanstack/react-router";
import { CatalogPage as Catalog } from "@executor-js/ui/dashboard/catalog";
import { useOrganizationRoute } from "../components/organization.tsx";
import { MakeYourOwn, AddAppBack } from "../components/add-app.tsx";

/** Catalog apps install into the same organization-owned app records. */
export function AddAppPage() {
  const atoms = useDashboardAtoms();
  useAtomMount(atoms.catalog);
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <Catalog
      query={atoms.catalog}
      Failure={HostedFailure}
      mutation={atoms.install}
      InstallFailure={HostedFailure}
      inventory={atoms.inventory}
      open={(app) => (
        <Link
          to="/org/$organizationSlug/apps/$appId"
          search={{ view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview" }}
          params={{ organizationSlug, appId: app.id }}
        >
          Open
        </Link>
      )}
      back={<AddAppBack organizationSlug={organizationSlug} />}
      action={<MakeYourOwn appearance="button" />}
      create={<MakeYourOwn />}
    />
  );
}
