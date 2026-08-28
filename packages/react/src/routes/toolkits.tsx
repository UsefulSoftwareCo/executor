import { Schema } from "effect";
import { createFileRoute, useParams } from "@tanstack/react-router";

import { ToolkitsPluginRoute } from "./toolkits-route";
import { useExecutorDocumentTitle } from "../lib/document-title";

export const Route = createFileRoute("/{-$orgSlug}/toolkits")({
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ tool: Schema.optional(Schema.String) }),
  ),
  component: ToolkitsRouteComponent,
});

function ToolkitsRouteComponent() {
  useExecutorDocumentTitle("Toolkits");
  const { toolkitSlug } = useParams({ strict: false }) as { toolkitSlug?: string };
  const { tool } = Route.useSearch();
  return <ToolkitsPluginRoute toolkitSlug={toolkitSlug} search={{ tool }} />;
}
