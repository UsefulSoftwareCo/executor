import { parseSetupSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { parseAppParams } from "@executor-js/hosted-web/route-params";

export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/setup")({
  params: { parse: parseAppParams },
  validateSearch: parseSetupSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/org/$organizationSlug/apps/$appId",
      params: { organizationSlug: params.organizationSlug, appId: params.appId },
      search: { view: "accounts", profile: search.profile },
      replace: true,
    });
  },
});