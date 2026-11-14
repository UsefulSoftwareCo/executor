import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { Link } from "@tanstack/react-router";
import { CatalogPage as Catalog } from "@executor-js/ui/dashboard/catalog";
import { MakeYourOwn } from "../components/add-app.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

/** Discovery and installation use the existing local app and account setup routes; Open leads there. */
export function CatalogPage() {
  return (
    <Catalog
      query={dashboardAtoms.catalog}
      Failure={Failure}
      mutation={dashboardAtoms.install}
      InstallFailure={Failure}
      inventory={dashboardAtoms.inventory}
      open={(app) => (
        <Link
          to={Object.keys(app.requirements.accounts).length ? "/apps/$appId/setup" : "/apps/$appId"}
          params={{ appId: app.id }}
        >
          Open
        </Link>
      )}
      back={
        <Link
          to="/apps"
          className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
          Apps
        </Link>
      }
      action={<MakeYourOwn appearance="button" />}
      create={<MakeYourOwn />}
    />
  );
}
