import { reportBrowserUsage } from "../../contracts/product-analytics.ts";
import { Option, Schema } from "effect";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { CustomAppForm, CustomAppKind } from "@executor-js/ui/dashboard/custom-app";
import { Tabs, TabsList, TabsTrigger } from "@executor-js/ui/components/tabs";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Member-owned remote imports use organization-bound mutations on both hosted products. */
export function CustomAppPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const atoms = useDashboardAtoms();
  const navigate = useNavigate();
  const [kind, setKind] = useState<typeof CustomAppKind.Type>("mcp");
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Link
        to="/org/$organizationSlug/apps/add"
        params={{ organizationSlug }}
        className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden size={14} />
        All apps
      </Link>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Add custom app
        </h1>
      </div>
      <Tabs
        value={kind}
        onValueChange={(value) => {
          const parsed = Schema.decodeUnknownOption(CustomAppKind)(value);
          if (Option.isSome(parsed)) {
            reportBrowserUsage({
              area: "apps",
              action: `select_${parsed.value}`,
              outcome: "started",
            });
            setKind(parsed.value);
          }
        }}
      >
        <TabsList aria-label="App template">
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="graphql">GraphQL</TabsTrigger>
          <TabsTrigger value="openapi">OpenAPI</TabsTrigger>
        </TabsList>
      </Tabs>
      <CustomAppForm
        key={`${organization}:${kind}`}
        kind={kind}
        mutation={atoms.importCustom}
        Failure={HostedFailure}
        onInstalled={(app) =>
          navigate({
            to: "/org/$organizationSlug/apps/$appId",
            search: {
              view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview",
            },
            params: { organizationSlug, appId: app.id },
          })
        }
      />
    </div>
  );
}
