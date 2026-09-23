import { createFileRoute } from "@tanstack/react-router";
import { WebhookSetupPage } from "@executor-js/hosted-web/pages/webhook-setup";
/** The organization and subscription identity are explicit in the URL. */
export const Route = createFileRoute("/org/$organizationSlug/webhooks/$appId/$subscriptionId")({
  component: () => <WebhookSetupPage {...Route.useParams()} />,
});
