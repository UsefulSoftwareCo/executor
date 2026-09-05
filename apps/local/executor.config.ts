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

export default defineExecutorConfig({
  plugins: () =>
    [
      openApiHttpPlugin({
        presets: [...googleCatalog, ...microsoftCatalog],
        specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
      }),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: true }),
      graphqlHttpPlugin(),
      toolkitsPlugin(),
      // The durable file store must register before keychain: the first
      // writable provider becomes the default for minted OAuth tokens, and on
      // sandbox/headless hosts the keychain is an in-memory keyring that a
      // stop/recreate wipes while only EXECUTOR_DATA_DIR is persisted.
      // Keychain stays registered for explicit external refs.
      fileSecretsPlugin(),
      keychainPlugin(),
      onepasswordHttpPlugin(),
      desktopSettingsPlugin({
        webBaseUrl:
          process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
      }),
    ] as const,
});
