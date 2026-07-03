import { createFileRoute } from "@tanstack/react-router";

import { ToolsPage } from "../pages/tools";
import { consoleBasePath } from "./base-path";

export const Route = createFileRoute("/{-$orgSlug}/tools")({
  component: () => {
    const { orgSlug } = Route.useParams();
    return <ToolsPage basePath={consoleBasePath(orgSlug)} />;
  },
});
