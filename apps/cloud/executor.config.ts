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
import {
  makeDynamicWorkerAppToolExecutor,
  makeDynamicWorkerBundlerBackend,
} from "@executor-js/plugin-apps/cloud";
import { appsHttpPlugin } from "@executor-js/plugin-apps/api";
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
  /** Mirrors `HostConfig.allowLocalNetwork` (`ALLOW_LOCAL_NETWORK`). Off by
   *  default; production leaves it unset. */
  readonly allowLocalNetwork?: boolean;
  readonly workerLoader?: {
    readonly get: (
      name: string | null,
      factory: () => {
        readonly compatibilityDate: string;
        readonly compatibilityFlags?: readonly string[];
        readonly mainModule: string;
        readonly modules: Readonly<Record<string, string | { readonly wasm: ArrayBuffer }>>;
        readonly globalOutbound?: null;
      },
    ) => { readonly getEntrypoint: () => unknown };
    readonly load?: (code: {
      readonly compatibilityDate: string;
      readonly compatibilityFlags?: readonly string[];
      readonly mainModule: string;
      readonly modules: Readonly<Record<string, string | { readonly wasm: ArrayBuffer }>>;
      readonly globalOutbound?: null;
    }) => { readonly getEntrypoint: () => unknown };
  };
  readonly workerAssets?: {
    readonly fetch: (request: Request) => Promise<Response>;
  };
}

const base64ToArrayBuffer = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const assetRequest = (path: string): Request => new Request(new URL(path, "https://assets.local"));

const fetchAsset = async (
  assets: { readonly fetch: (request: Request) => Promise<Response> },
  path: string,
): Promise<Response> => {
  const response = await assets.fetch(assetRequest(path));
  if (!response.ok) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: worker artifact asset fetch must reject the dynamic bundler setup
    throw new Error(`failed to fetch worker-bundler asset ${path}: ${response.status}`);
  }
  return response;
};

export default defineExecutorConfig({
  plugins: ({
    workosCredentials,
    workosVaultClient,
    activeToolkitSlug,
    allowLocalNetwork,
    workerLoader,
    workerAssets,
  }: CloudPluginDeps = {}) =>
    [
      openApiHttpPlugin({
        presets: [...googleCatalog, ...microsoftCatalog],
        specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
      }),
      mcpHttpPlugin({
        dangerouslyAllowStdioMCP: false,
      }),
      graphqlHttpPlugin(),
      appsHttpPlugin({
        ...(workerLoader
          ? {
              executor: makeDynamicWorkerAppToolExecutor({ loader: workerLoader }),
              bundler: makeDynamicWorkerBundlerBackend({
                loader: workerLoader,
                artifact: async () => {
                  const artifact = await import("virtual:executor/worker-bundler-artifact");
                  if (artifact.source !== undefined && artifact.wasmBase64 !== undefined) {
                    return {
                      source: artifact.source,
                      wasm: base64ToArrayBuffer(artifact.wasmBase64),
                    };
                  }
                  if (workerAssets === undefined) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: worker artifact asset binding is required for production bundler setup
                    throw new Error("worker-bundler artifact assets binding is unavailable");
                  }
                  const [source, wasm] = await Promise.all([
                    fetchAsset(workerAssets, artifact.sourcePath).then((response) =>
                      response.text(),
                    ),
                    fetchAsset(workerAssets, artifact.wasmPath).then((response) =>
                      response.arrayBuffer(),
                    ),
                  ]);
                  return {
                    source,
                    wasm,
                  };
                },
              }),
            }
          : {}),
        sourceKinds: ["git"],
        allowPrivateGitHosts: allowLocalNetwork === true,
      }),
      toolkitsPlugin({ activeToolkitSlug }),
      workosVaultPlugin({
        credentials: workosCredentials ?? { apiKey: "", clientId: "" },
        ...(workosVaultClient ? { client: workosVaultClient } : {}),
      }),
    ] as const,
});
