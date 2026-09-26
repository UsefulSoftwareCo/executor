import { createFileRoute } from "@tanstack/react-router";
import { WebhookSetupPage } from "../pages/webhook-setup.tsx";
import { parseWebhookParams } from "../route-params.ts";
/** Manual setup uses the existing local dashboard authentication gate. */
export const Route = createFileRoute("/_dashboard/webhooks/$appId/$subscriptionId")({
  staticData: { section: "apps" },
  params: { parse: parseWebhookParams },
  component: () => <WebhookSetupPage {...Route.useParams()} />,
});
