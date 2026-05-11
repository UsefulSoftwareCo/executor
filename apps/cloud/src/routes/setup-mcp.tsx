import { createFileRoute } from "@tanstack/react-router";
import { SetupMcpPage } from "../web/pages/setup-mcp";

export const Route = createFileRoute("/setup-mcp")({
  component: SetupMcpPage,
});
