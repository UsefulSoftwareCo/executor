import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { ToolkitsPluginRoute } from "./toolkits-route";

export const Route = createFileRoute("/{-$orgSlug}/toolkits/$toolkitSlug")({
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ tool: Schema.optional(Schema.String) }),
  ),
  component: ToolkitsRouteComponent,
});

function ToolkitsRouteComponent() {
  const { toolkitSlug } = Route.useParams();
  const { tool } = Route.useSearch();
  return <ToolkitsPluginRoute toolkitSlug={toolkitSlug} search={{ tool }} />;
}
