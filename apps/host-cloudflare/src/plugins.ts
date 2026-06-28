import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { googleHttpPlugin } from "@executor-js/plugin-google/api";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

// ---------------------------------------------------------------------------
// The Cloudflare host's plugin list — the same protocol/provider plugins as
// self-host (no WorkOS Vault). Built as a factory because the encrypted-secrets
// master key arrives via `env` at request time (no process.env on a Worker), so
// the plugin set is constructed per app-build with the resolved key. The tuple
// SHAPE (which drives the API + table set) is independent of the key value.
//
// `dangerouslyAllowStdioMCP` is false: a multi-user instance must not let a user
// spawn arbitrary stdio MCP processes.
// ---------------------------------------------------------------------------

export const makeCloudflarePlugins = (
  secretKey: string,
  options: { readonly activeToolkitSlug?: string } = {},
) =>
  [
    openApiHttpPlugin(),
    googleHttpPlugin(),
    microsoftHttpPlugin(),
    mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlHttpPlugin(),
    toolkitsPlugin({ activeToolkitSlug: options.activeToolkitSlug }),
    encryptedSecretsPlugin({ key: secretKey }),
  ] as const;

export type CloudflarePlugins = ReturnType<typeof makeCloudflarePlugins>;
