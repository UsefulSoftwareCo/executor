import { defineExecutorConfig } from "@executor-js/sdk";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { googleHttpPlugin } from "@executor-js/plugin-google/api";
import { microsoftHttpPlugin } from "@executor-js/plugin-microsoft/api";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { workosVaultPlugin, type WorkOSVaultClient } from "@executor-js/plugin-workos-vault";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

// ---------------------------------------------------------------------------
// Single source of truth for the cloud app's plugin list.
//
// Consumed by:
//   - the host runtime (calls `plugins({ workosCredentials })` per request)
//   - the build/UI tooling (the vite plugin calls `plugins()` no-arg, reads
//     `plugin.packageName` only)
//   - the test harness (calls `plugins({ workosVaultClient })` per test)
// (NOT by schema generation — the executor table set is fixed and
// plugin-independent, see `collectTables()`.)
//
// `TDeps` is inferred directly from the factory parameter annotation —
// no global `declare module "@executor-js/sdk"` augmentation. Each
// caller (runtime / build tooling / tests) passes whatever subset of the deps
// it has; all fields are optional so `plugins({})` keeps working.
//
// Cloud only ships plugins safe to run in a multi-tenant setting — no
// stdio MCP, no keychain/file-secrets/1password.
// ---------------------------------------------------------------------------

interface CloudPluginDeps {
  /** WorkOS vault credentials. Provided per-request from `env.WORKOS_*`
   *  in production; the test harness leaves this undefined and uses
   *  `workosVaultClient` to inject an in-memory fake instead. */
  readonly workosCredentials?: {
    readonly apiKey: string;
    readonly clientId: string;
    /** Optional WorkOS API base-URL override (WorkOS emulator in tests/dev). */
    readonly apiUrl?: string;
  };
  /** Pluggable WorkOS Vault HTTP client — set by the test harness to
   *  bypass the real WorkOS API. Production leaves this undefined and
   *  falls back to the credential-driven default. */
  readonly workosVaultClient?: WorkOSVaultClient;
  readonly activeToolkitSlug?: string;
}

export default defineExecutorConfig({
  plugins: ({ workosCredentials, workosVaultClient, activeToolkitSlug }: CloudPluginDeps = {}) =>
    [
      openApiHttpPlugin(),
      googleHttpPlugin(),
      microsoftHttpPlugin(),
      mcpHttpPlugin({
        dangerouslyAllowStdioMCP: false,
      }),
      graphqlHttpPlugin(),
      toolkitsPlugin({ activeToolkitSlug }),
      workosVaultPlugin({
        credentials: workosCredentials ?? { apiKey: "", clientId: "" },
        ...(workosVaultClient ? { client: workosVaultClient } : {}),
      }),
    ] as const,
});
