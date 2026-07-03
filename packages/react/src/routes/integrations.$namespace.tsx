import { createFileRoute } from "@tanstack/react-router";

import { IntegrationDetailPage } from "../pages/integration-detail";
import { consoleBasePath } from "./base-path";

export const Route = createFileRoute("/{-$orgSlug}/integrations/$namespace")({
  component: () => {
    const { namespace, orgSlug } = Route.useParams();
    return <IntegrationDetailPage basePath={consoleBasePath(orgSlug)} namespace={namespace} />;
  },
});
