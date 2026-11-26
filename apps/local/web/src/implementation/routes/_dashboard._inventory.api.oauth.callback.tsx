import { createFileRoute } from "@tanstack/react-router";
import { OAuthCallbackPage } from "../pages/oauth.tsx";
export const Route = createFileRoute("/_dashboard/_inventory/api/oauth/callback")({
  component: OAuthCallbackPage,
});
