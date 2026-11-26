import { Link, useNavigate } from "@tanstack/react-router";
import type { DeployedApp } from "@executor-js/sdk";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import {
  MakeYourOwn as SharedMakeYourOwn,
  AddAppMenu as SharedMenu,
} from "@executor-js/ui/dashboard/add-app";
import { useMcpOrigin } from "../resource-origin.ts";
import { HostedFailure, useDashboardAtoms } from "./dashboard-bindings.tsx";
import { useOrganizationRoute } from "./organization.tsx";

export function AddAppBack({ organizationSlug }: { readonly organizationSlug: string }) {
  return (
    <Link
      to="/org/$organizationSlug/apps"
      params={{ organizationSlug }}
      className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
    >
      <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
      Apps
    </Link>
  );
}

function useAddAppDialogs() {
  const mcpOrigin = useMcpOrigin();
  const { slug: organizationSlug } = useOrganizationRoute();
  const atoms = useDashboardAtoms();
  const navigate = useNavigate();
  return {
    endpoint: `${mcpOrigin}/mcp`,
    mutation: atoms.importCustom,
    Failure: HostedFailure,
    onInstalled: (app: DeployedApp) =>
      navigate({
        to: "/org/$organizationSlug/apps/$appId",
        search: { view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview" },
        params: { organizationSlug, appId: app.id },
      }),
  };
}

export function AddAppMenu() {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <SharedMenu
      {...useAddAppDialogs()}
      catalog={(content) => (
        <Link to="/org/$organizationSlug/apps/add" params={{ organizationSlug }}>
          {content}
        </Link>
      )}
    />
  );
}

export function MakeYourOwn({ appearance }: { readonly appearance?: "link" | "button" }) {
  return <SharedMakeYourOwn appearance={appearance} {...useAddAppDialogs()} />;
}
