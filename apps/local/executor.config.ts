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
      mcpHttpPlugin({
        // Stdio MCP servers spawn arbitrary local processes. Default OFF for
        // the shipped local app; opt in explicitly only for trusted local
        // contexts (the e2e harness sets EXECUTOR_ALLOW_STDIO_MCP=1 for its
        // dedicated stdio scenarios). The MCP plugin itself rejects stdio
        // connections with a clear error when this flag is false (see
        // plugin.ts resolveConnector).
        dangerouslyAllowStdioMCP: process.env.EXECUTOR_ALLOW_STDIO_MCP === "1",
      }),
      graphqlHttpPlugin(),
      toolkitsPlugin({ activeToolkitSlug }),
      // Secrets ordering — CAUSAL KNOWLEDGE, encoded:
      //
      // The FIRST writable credential provider becomes the default for
      // minted OAuth tokens. On macOS/Windows the OS keychain is a durable
      // persistent store, so keychain must register FIRST to become the
      // default there. On Linux/headless/sandbox hosts the keychain probe
      // (write+delete sentinel) fails or degrades to an in-memory keyring
      // that a stop/recreate wipes while only EXECUTOR_DATA_DIR persists —
      // the keychain plugin's credentialProviders() then returns [] and the
      // file store naturally becomes the default. This ordering therefore
      // yields "keychain default where durable, file fallback where not"
      // without any runtime switch.
      //
      // If the platform truth changes (e.g. a durable Linux backend ships),
      // update describeKeychainAvailability() in @executor-js/plugin-keychain
      // — not this comment.
      keychainPlugin(),
      fileSecretsPlugin(),
      onepasswordHttpPlugin(),
      desktopSettingsPlugin({
        webBaseUrl:
          process.env.EXECUTOR_WEB_BASE_URL ?? `http://localhost:${process.env.PORT ?? "4788"}`,
      }),
    ] as const,
});
