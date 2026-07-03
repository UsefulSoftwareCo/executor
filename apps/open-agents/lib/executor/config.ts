import { join } from "node:path";
import { defineExecutorConfig } from "@executor-js/sdk";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { openAgentsAutomationPlugin } from "@/lib/automation/executor-plugin";

const dataDir =
  process.env.OPEN_AGENTS_EXECUTOR_DATA_DIR ??
  join(process.cwd(), ".open-agents-executor");

const executorConfig = defineExecutorConfig({
  plugins: () =>
    [
      openApiHttpPlugin(),
      mcpHttpPlugin(),
      graphqlHttpPlugin(),
      fileSecretsPlugin({ directory: dataDir }),
      openAgentsAutomationPlugin(),
    ] as const,
});

export const openAgentsExecutorPlugins = executorConfig.plugins();
export type OpenAgentsExecutorPlugins = typeof openAgentsExecutorPlugins;
