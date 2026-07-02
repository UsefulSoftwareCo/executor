import { createFileRoute } from "@tanstack/react-router";

import { IntegrationDetailPage } from "../pages/integration-detail";

export const Route = createFileRoute("/{-$orgSlug}/integrations/$namespace")({
  component: () => {
    const { namespace } = Route.useParams();
    return <IntegrationDetailPage namespace={namespace} />;
  },
});
