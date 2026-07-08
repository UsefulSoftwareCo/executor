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
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

import { resolveSecretKey } from "./src/config";

// ---------------------------------------------------------------------------
// Single source of truth for the self-hosted app's plugin list.
//
// Self-host runs the same protocol/provider plugins as cloud, minus the
// multi-tenant-only secret backends (WorkOS Vault). `dangerouslyAllowStdioMCP`
// is false: a server reachable by multiple users must not let one user spawn
// arbitrary stdio MCP processes on the host. The encrypted DB secret provider
// (slice 4) is added here as the first writable secret provider.
// ---------------------------------------------------------------------------

interface SelfHostPluginDeps {
  readonly activeToolkitSlug?: string;
}

export default defineExecutorConfig({
  plugins: ({ activeToolkitSlug }: SelfHostPluginDeps = {}) =>
    [
      openApiHttpPlugin({
        presets: [...googleCatalog, ...microsoftCatalog],
        specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
      }),
      mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
      graphqlHttpPlugin(),
      toolkitsPlugin({ activeToolkitSlug }),
      // First writable secret provider -> the default for `secrets.set`.
      encryptedSecretsPlugin({ key: resolveSecretKey() }),
    ] as const,
});
