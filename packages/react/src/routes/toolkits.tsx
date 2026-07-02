import { createFileRoute, useParams } from "@tanstack/react-router";

import { ToolkitsPluginRoute } from "./toolkits-route";
import { useExecutorDocumentTitle } from "../lib/document-title";

export const Route = createFileRoute("/{-$orgSlug}/toolkits")({
  component: ToolkitsRouteComponent,
});

function ToolkitsRouteComponent() {
  useExecutorDocumentTitle("Toolkits");
  const { toolkitSlug } = useParams({ strict: false }) as { toolkitSlug?: string };
  return <ToolkitsPluginRoute toolkitSlug={toolkitSlug} />;
}
