import { appManagement } from "../../contracts/app-management.ts";
import { useAtomMount } from "@effect/atom-react";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import { CatalogPage as Catalog, CatalogInstall } from "@executor-js/ui/dashboard/catalog";
import { InstallPublication } from "@executor-js/ui/dashboard/install-publication";
import { type AppAcknowledgement } from "@executor-js/ui/contracts/app-management";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { Publication } from "@executor-js/app-registry/contracts";
import type { App } from "@executor-js/sdk";
import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { useOrganizationRoute } from "../components/organization.tsx";
import { acknowledgeApp } from "../../contracts/apps.ts";

type Selection =
  | { readonly kind: "catalog"; readonly entry: CatalogEntry }
  | { readonly kind: "publication"; readonly publication: typeof Publication.Type };
/** Public publications and integration templates share Add app and the same organization-owned app records. */
export function AddAppPage() {
  const atoms = useDashboardAtoms();
  useAtomMount(atoms.catalog);
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const management = appManagement(organization);
  const [selection, setSelection] = useState<Selection>();
  const onApp: AppAcknowledgement = (get, app) => acknowledgeApp(get, organization, app);
  const installed = (app: App) =>
    navigate({
      to: Object.keys(app.requirements.accounts).length
        ? "/org/$organizationSlug/apps/$appId/setup"
        : "/org/$organizationSlug/apps/$appId",
      params: { organizationSlug, appId: app.id },
    });
  const back = () => setSelection(undefined);
  if (selection?.kind === "publication")
    return (
      <InstallPublication
        key={`${selection.publication.name}:${selection.publication.commit}`}
        Failure={HostedFailure}
        publication={selection.publication}
        atoms={management}
        onApp={onApp}
        onInstalled={installed}
        onBack={back}
      />
    );
  if (selection?.kind === "catalog")
    return (
      <CatalogInstall
        mutation={atoms.install}
        Failure={HostedFailure}
        key={selection.entry.id}
        entry={selection.entry}
        onBack={back}
        onInstalled={installed}
      />
    );
  return (
    <Catalog
      query={atoms.catalog}
      publications={management.catalog}
      PublicationFailure={HostedFailure}
      Failure={HostedFailure}
      onSelect={(entry) => setSelection({ kind: "catalog", entry })}
      onPublication={(publication) => setSelection({ kind: "publication", publication })}
      back={
        <Link
          to="/org/$organizationSlug/apps"
          params={{ organizationSlug }}
          className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
          Apps
        </Link>
      }
      action={
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/org/$organizationSlug/apps/add/custom" params={{ organizationSlug }}>
              Connect a service
            </Link>
          </Button>
        </div>
      }
    />
  );
}
