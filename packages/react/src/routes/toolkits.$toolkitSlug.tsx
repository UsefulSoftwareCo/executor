import { createFileRoute } from "@tanstack/react-router";

import { ToolkitsPluginRoute } from "./toolkits-route";

export const Route = createFileRoute("/{-$orgSlug}/toolkits/$toolkitSlug")({
  component: ToolkitsRouteComponent,
});

function ToolkitsRouteComponent() {
  const { toolkitSlug } = Route.useParams();
  return <ToolkitsPluginRoute toolkitSlug={toolkitSlug} />;
}
