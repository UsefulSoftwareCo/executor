import { createFileRoute } from "@tanstack/react-router";
import { WebhookSetupPage } from "../pages/webhook-setup.tsx";
/** Manual setup uses the existing local dashboard authentication gate. */
export const Route = createFileRoute("/_dashboard/webhooks/$appId/$subscriptionId")({
  staticData: { section: "apps" },
  component: () => <WebhookSetupPage {...Route.useParams()} />,
});
