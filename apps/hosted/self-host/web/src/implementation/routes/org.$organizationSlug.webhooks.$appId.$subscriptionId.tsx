import { createFileRoute } from "@tanstack/react-router";
import { WebhookSetupPage } from "@executor-js/hosted-web/pages/webhook-setup";
import { parseWebhookParams } from "@executor-js/hosted-web/route-params";
/** The organization and subscription identity are explicit in the URL. */
export const Route = createFileRoute("/org/$organizationSlug/webhooks/$appId/$subscriptionId")({
  params: { parse: parseWebhookParams },
  component: () => <WebhookSetupPage {...Route.useParams()} />,
});
