import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsPage } from "../pages/integrations";
import { consoleBasePath } from "./base-path";

export const Route = createFileRoute("/{-$orgSlug}/")({
  component: () => {
    const { orgSlug } = Route.useParams();
    return <IntegrationsPage basePath={consoleBasePath(orgSlug)} />;
  },
});
