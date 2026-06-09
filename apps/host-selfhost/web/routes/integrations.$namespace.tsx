import { createFileRoute } from "@tanstack/react-router";
import { IntegrationDetailPage } from "@executor-js/react/pages/integration-detail";

export const Route = createFileRoute("/integrations/$namespace")({
  component: () => {
    const { namespace } = Route.useParams();
    return <IntegrationDetailPage namespace={namespace} />;
  },
});
