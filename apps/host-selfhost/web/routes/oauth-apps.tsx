import { createFileRoute } from "@tanstack/react-router";
import { OAuthAppsPage } from "@executor-js/react/pages/oauth-apps";

export const Route = createFileRoute("/oauth-apps")({
  component: OAuthAppsPage,
});
