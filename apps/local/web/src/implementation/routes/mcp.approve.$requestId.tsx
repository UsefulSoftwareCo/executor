import { createFileRoute } from "@tanstack/react-router";
import { McpApprovePage } from "../pages/mcp-approve.tsx";
export const Route = createFileRoute("/mcp/approve/$requestId")({ component: McpApprovePage });
