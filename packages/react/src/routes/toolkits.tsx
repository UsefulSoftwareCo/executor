import { createFileRoute, useParams } from "@tanstack/react-router";

import { ToolkitsPluginRoute } from "./toolkits-route";

export const Route = createFileRoute("/{-$orgSlug}/toolkits")({
  component: ToolkitsRouteComponent,
});

function ToolkitsRouteComponent() {
  const { toolkitSlug } = useParams({ strict: false }) as { toolkitSlug?: string };
  return <ToolkitsPluginRoute toolkitSlug={toolkitSlug} />;
}
