import { createFileRoute } from "@tanstack/react-router";

import { ToolsPage } from "../pages/tools";

export const Route = createFileRoute("/{-$orgSlug}/tools")({
  component: ToolsPage,
});
