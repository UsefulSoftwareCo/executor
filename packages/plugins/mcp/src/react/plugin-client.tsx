import { defineClientPlugin } from "@executor-js/sdk/client";

import { createMcpIntegrationPlugin } from "./source-plugin";

export default function createMcpClientPlugin() {
  return defineClientPlugin({
    id: "mcp" as const,
    integrationPlugin: createMcpIntegrationPlugin(),
  });
}
