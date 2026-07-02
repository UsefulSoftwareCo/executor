import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsPage } from "../pages/integrations";

export const Route = createFileRoute("/{-$orgSlug}/")({
  component: IntegrationsPage,
});
