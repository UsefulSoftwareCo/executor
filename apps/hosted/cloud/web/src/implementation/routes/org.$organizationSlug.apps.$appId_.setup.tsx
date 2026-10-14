import { createFileRoute, redirect } from "@tanstack/react-router";
import { parseAppParams } from "@executor-js/hosted-web/route-params";

/**
 * Account management lives on the app; older setup links open its Accounts tab. The redirect
 * happens while routing, so a document gets it from the server before any page renders. A page
 * that rendered `<Navigate>` here restarted its navigation whenever the organization layout
 * re-rendered, so it never finished and froze the tab. notes/dashboard-rendering.md puts fixed
 * redirects in the host's router; these links are rare, so the session read before this redirect
 * is an acceptable cost, and `parseAppParams` stays the one check of the app ID. A signed-out
 * visitor signs in first and returns here.
 */
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
