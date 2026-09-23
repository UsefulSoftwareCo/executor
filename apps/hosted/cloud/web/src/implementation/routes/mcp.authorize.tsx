import { createFileRoute } from "@tanstack/react-router";
import { McpAuthorizePage } from "@executor-js/hosted-web/pages/mcp-authorize";

export const Route = createFileRoute("/mcp/authorize")({ component: McpAuthorizePage });
