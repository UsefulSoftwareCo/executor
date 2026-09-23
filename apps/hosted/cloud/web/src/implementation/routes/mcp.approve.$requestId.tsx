import { createFileRoute } from "@tanstack/react-router";
import { McpApprovePage } from "@executor-js/hosted-web/pages/mcp-approve";
export const Route = createFileRoute("/mcp/approve/$requestId")({ component: McpApprovePage });
