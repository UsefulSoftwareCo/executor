import { createFileRoute } from "@tanstack/react-router";

import { ConnectIntegrationPage } from "../pages/connect-integration";

export const Route = createFileRoute("/{-$orgSlug}/connect/$integrationSlug")({
  component: () => {
    const { integrationSlug } = Route.useParams();
    return <ConnectIntegrationPage integrationSlug={integrationSlug} />;
  },
});
