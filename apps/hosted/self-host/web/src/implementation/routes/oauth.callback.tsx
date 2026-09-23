import { createFileRoute } from "@tanstack/react-router";
import { OAuthCallbackPage } from "@executor-js/hosted-web/pages/oauth-callback";

export const Route = createFileRoute("/oauth/callback")({ component: OAuthCallbackPage });
