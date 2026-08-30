import { createFileRoute } from "@tanstack/react-router";

import { IntegrationBrowsePage } from "../pages/integration-browse";

export const Route = createFileRoute("/{-$orgSlug}/integrations/browse")({
  component: IntegrationBrowsePage,
});
