import { createFileRoute, redirect } from "@tanstack/react-router";
import { parseAppParams } from "@executor-js/hosted-web/route-params";

export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/setup")({
  params: { parse: parseAppParams },
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/org/$organizationSlug/apps/$appId",
      params,
      search: { view: "accounts" },
      replace: true,
    });
  },
});
