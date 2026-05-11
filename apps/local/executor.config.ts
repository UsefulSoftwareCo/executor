import { defineExecutorConfig } from "@executor-js/sdk";
import type { ConfigFileSink } from "@executor-js/config";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { onepasswordHttpPlugin } from "@executor-js/plugin-onepassword/api";

// ---------------------------------------------------------------------------
// Single source of truth for the local app's plugin list.
//
// Consumed by:
//   - the schema-gen CLI (reads `plugin.schema` only; calls `plugins({})`)
//   - the host runtime (calls `plugins({ configFile })` with a real sink)
//
// `TDeps` is inferred from the factory parameter annotation directly.
// First-party and third-party plugins use the same import-and-call flow.
// ---------------------------------------------------------------------------

interface LocalPluginDeps {
  readonly configFile?: ConfigFileSink;
}

export default defineExecutorConfig({
  dialect: "sqlite",
  plugins: ({ configFile }: LocalPluginDeps = {}) =>
    [
      openApiHttpPlugin({ configFile }),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: true, configFile }),
      graphqlHttpPlugin({ configFile }),
      keychainPlugin(),
      fileSecretsPlugin(),
      onepasswordHttpPlugin(),
    ] as const,
});
