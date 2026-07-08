import { defineExecutorConfig } from "@executor-js/sdk";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { onepasswordHttpPlugin } from "@executor-js/plugin-onepassword/api";
import { desktopSettingsPlugin } from "@executor-js/plugin-desktop-settings/server";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

// ---------------------------------------------------------------------------
// Single source of truth for the local app's plugin list.
//
// Consumed by the host runtime. Executor owns the storage tables; plugins use
// host-provided storage facades instead of contributing schema.
//
// First-party and third-party plugins use the same import-and-call flow.
// ---------------------------------------------------------------------------

interface LocalPluginDeps {
  readonly activeToolkitSlug?: string;
}

export default defineExecutorConfig({
  plugins: ({ activeToolkitSlug }: LocalPluginDeps = {}) =>
    [
      openApiHttpPlugin({
        presets: [...googleCatalog, ...microsoftCatalog],
        specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
      }),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: true }),
      graphqlHttpPlugin(),
      toolkitsPlugin({ activeToolkitSlug }),
      keychainPlugin(),
      fileSecretsPlugin(),
      onepasswordHttpPlugin(),
      desktopSettingsPlugin({
        webBaseUrl:
          process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
      }),
    ] as const,
});
