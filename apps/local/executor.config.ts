import { defineExecutorConfig } from "@executor-js/sdk";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { googleDiscoveryHttpPlugin } from "@executor-js/plugin-google-discovery/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { onepasswordHttpPlugin } from "@executor-js/plugin-onepassword/api";
import { desktopSettingsPlugin } from "@executor-js/plugin-desktop-settings/server";

// ---------------------------------------------------------------------------
// Single source of truth for the local app's plugin list.
//
// Consumed by the host runtime. The runtime passes the merged plugin tables
// to FumaDB directly; there is no separate Executor schema-generation step.
//
// First-party and third-party plugins use the same import-and-call flow.
// ---------------------------------------------------------------------------

export default defineExecutorConfig({
  plugins: () =>
    [
      openApiHttpPlugin(),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: true }),
      googleDiscoveryHttpPlugin(),
      graphqlHttpPlugin(),
      keychainPlugin(),
      fileSecretsPlugin(),
      onepasswordHttpPlugin(),
      desktopSettingsPlugin({
        webBaseUrl:
          process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
      }),
    ] as const,
});
