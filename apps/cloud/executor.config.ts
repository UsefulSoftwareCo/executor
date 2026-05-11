import { defineExecutorConfig } from "@executor-js/sdk";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { workosVaultPlugin, type WorkOSVaultClient } from "@executor-js/plugin-workos-vault";

// ---------------------------------------------------------------------------
// Single source of truth for the cloud app's plugin list.
//
// Consumed by:
//   - the schema-gen CLI (reads `plugin.schema` only; calls `plugins({})`)
//   - the host runtime (calls `plugins({ workosCredentials })` per request)
//   - the test harness (calls `plugins({ workosVaultClient })` per test)
//
// `TDeps` is inferred directly from the factory parameter annotation —
// no global `declare module "@executor-js/sdk"` augmentation. Each
// caller (runtime / CLI / tests) passes whatever subset of the deps it
// has; all fields are optional so the CLI's `plugins({})` keeps working.
//
// Cloud only ships plugins safe to run in a multi-tenant setting — no
// stdio MCP, no keychain/file-secrets/1password/google-discovery.
// ---------------------------------------------------------------------------

interface CloudPluginDeps {
  /** WorkOS vault credentials. Provided per-request from `env.WORKOS_*`
   *  in production; the test harness leaves this undefined and uses
   *  `workosVaultClient` to inject an in-memory fake instead. */
  readonly workosCredentials?: {
    readonly apiKey: string;
    readonly clientId: string;
  };
  /** Pluggable WorkOS Vault HTTP client — set by the test harness to
   *  bypass the real WorkOS API. Production leaves this undefined and
   *  falls back to the credential-driven default. */
  readonly workosVaultClient?: WorkOSVaultClient;
}

export default defineExecutorConfig({
  dialect: "pg",
  plugins: ({ workosCredentials, workosVaultClient }: CloudPluginDeps = {}) =>
    [
      openApiPlugin(),
      mcpPlugin({
        dangerouslyAllowStdioMCP: false,
      }),
      graphqlPlugin(),
      workosVaultPlugin({
        credentials: workosCredentials ?? { apiKey: "", clientId: "" },
        ...(workosVaultClient ? { client: workosVaultClient } : {}),
      }),
    ] as const,
});
