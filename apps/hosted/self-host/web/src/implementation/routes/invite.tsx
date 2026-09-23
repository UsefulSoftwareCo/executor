import { createFileRoute } from "@tanstack/react-router";
import { InvitePage, inviteSearch } from "@executor-js/hosted-web/pages/invite";

/** Link invitation entry, including users without an organization. */
export const Route = createFileRoute("/invite")({
  validateSearch: inviteSearch,
  component: () => <InvitePage {...Route.useSearch()} />,
});
