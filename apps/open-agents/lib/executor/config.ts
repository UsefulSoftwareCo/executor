import { defineExecutorConfig } from "@executor-js/sdk";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { openAgentsAutomationPlugin } from "@/lib/automation/executor-plugin";

function resolveExecutorSecretKey(): string {
  const secretKey = process.env.EXECUTOR_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("EXECUTOR_SECRET_KEY must be set");
  }
  return secretKey;
}

const executorConfig = defineExecutorConfig({
  plugins: () =>
    [
      openApiHttpPlugin(),
      mcpHttpPlugin(),
      graphqlHttpPlugin(),
      encryptedSecretsPlugin({ key: resolveExecutorSecretKey() }),
      openAgentsAutomationPlugin(),
    ] as const,
});

export const openAgentsExecutorPlugins = executorConfig.plugins();
export type OpenAgentsExecutorPlugins = typeof openAgentsExecutorPlugins;
