import { Suspense } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { OrganizationPage, type MemberLimit } from "@executor-js/hosted-web/pages/organization";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { Button } from "@executor-js/ui/components/button";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { DeleteOrganization } from "../components/delete-organization.tsx";
import { SsoSettings } from "../components/sso-settings.tsx";
import { BillingSettings } from "../components/billing-settings.tsx";
import { memberLimitAtom } from "../../contracts/billing.ts";

const noMemberLimit = Atom.make(AsyncResult.initial<{ readonly limit: number | null }>());

function useMemberLimit(): MemberLimit | undefined {
  const organization = useOrganizationRoute();
  const administrator = organization.role === "owner" || organization.role === "admin";
  const result = useAtomValue(
    administrator ? memberLimitAtom(organization.organization) : noMemberLimit,
  );
  const confirmed = Option.getOrUndefined(AsyncResult.value(result));
  if (confirmed === undefined) return undefined;
  return {
    limit: confirmed.limit,
    upgrade: (
      <Button asChild>
        <Link
          to="/org/$organizationSlug/billing"
          params={{ organizationSlug: organization.slug }}
          search={{ organization: "", plan: "" }}
        >
          Upgrade plan
        </Link>
      </Button>
    ),
  };
}

function CloudOrganizationPage() {
  return (
    <OrganizationPage
      emailInvitations
      memberLimit={useMemberLimit()}
      footer={<DeleteOrganization />}
    >
      <BillingSettings />
      <Suspense fallback={null}>
        <SsoSettings />
      </Suspense>
    </OrganizationPage>
  );
}

export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: CloudOrganizationPage,
});
