import { createFileRoute } from "@tanstack/react-router";
import { ToolsPage } from "@executor-js/react/pages/tools";

export const Route = createFileRoute("/$org/tools")({
  component: ToolsPage,
});
