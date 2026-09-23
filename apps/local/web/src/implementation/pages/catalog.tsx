import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { acknowledgeApp } from "../../contracts/apps.ts";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { Publication } from "@executor-js/app-registry/contracts";
import type { App } from "@executor-js/sdk";
import { CatalogPage as Catalog, CatalogInstall } from "@executor-js/ui/dashboard/catalog";
import { InstallPublication } from "@executor-js/ui/dashboard/install-publication";
import { appManagement } from "../../contracts/app-management.ts";
import { Button } from "@executor-js/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

type Selection =
  | { readonly kind: "catalog"; readonly entry: CatalogEntry }
  | { readonly kind: "publication"; readonly publication: typeof Publication.Type };
/** Discovery and installation use the existing local app and account setup routes. */
export function CatalogPage() {
  const [selection, setSelection] = useState<Selection>();
  const navigate = useNavigate();
  const management = appManagement;
  const installed = (app: App) =>
    navigate({
      to: Object.keys(app.requirements.accounts).length ? "/apps/$appId/setup" : "/apps/$appId",
      params: { appId: app.id },
    });
  const back = () => setSelection(undefined);
  if (selection?.kind === "publication")
    return (
      <InstallPublication
        key={`${selection.publication.name}:${selection.publication.commit}`}
        Failure={Failure}
        publication={selection.publication}
        atoms={management}
        onApp={acknowledgeApp}
        onInstalled={installed}
        onBack={back}
      />
    );
  if (selection?.kind === "catalog")
    return (
      <CatalogInstall
        mutation={dashboardAtoms.install}
        Failure={Failure}
        key={selection.entry.id}
        entry={selection.entry}
        onBack={back}
        onInstalled={installed}
      />
    );
  return (
    <Catalog
      query={dashboardAtoms.catalog}
      publications={management.catalog}
      PublicationFailure={Failure}
      Failure={Failure}
      onSelect={(entry) => setSelection({ kind: "catalog", entry })}
      onPublication={(publication) => setSelection({ kind: "publication", publication })}
      back={
        <Link
          to="/apps"
          className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
          Apps
        </Link>
      }
      action={
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/apps/add/custom">Connect a service</Link>
          </Button>
        </div>
      }
    />
  );
}
