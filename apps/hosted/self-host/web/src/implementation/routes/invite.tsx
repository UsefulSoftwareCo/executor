import { createFileRoute } from "@tanstack/react-router";
import { InvitePage, inviteSearch } from "@executor-js/hosted-web/pages/invite";

export const Route = createFileRoute("/invite")({
  validateSearch: inviteSearch,
  component: () => <InvitePage {...Route.useSearch()} />,
});
