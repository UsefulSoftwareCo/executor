import { Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  EngineDecorator,
  HostConfig,
  PluginsProvider,
} from "@executor-js/api/server";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import executorConfig from "../executor.config";
import { selfHostAnalytics, SelfHostAnalyticsEngineDecorator } from "./analytics";
import { SelfHostDb, SelfHostDbProvider } from "./db/self-host-db";
import { loadConfig } from "./config";

// ---------------------------------------------------------------------------
// Self-host execution-stack seams.
//
// The shared `makeExecutionStack` (@executor-js/api/server) owns the body:
//   makeScopedExecutor -> createExecutionEngine -> EngineDecorator.decorate.
// Self-host just supplies the five seam Layers it reads from. Differences from
// cloud: the QuickJS in-process code substrate (vs the Cloudflare dynamic
// worker) and an analytics engine decorator instead of cloud's usage metering.
//
//   - DbProvider          -> SelfHostDbProvider: projects the long-lived
//                            libSQL handle (built once at boot, see db/). The
//                            shared factory reads `db` per request without
//                            caching, so the long-lived lifetime is preserved.
//   - PluginsProvider      -> fresh `executor.config.ts#plugins()` per call,
//                            matching per-request plugin instances (avoids
//                            cross-request plugin state).
//   - HostConfig           -> deployment knobs from `loadConfig()` plus the
//                            selfhost callback path and analytics hooks (see
//                            `SelfHostHostConfig` below).
//   - CodeExecutorProvider -> `makeQuickJsExecutor()`.
//   - EngineDecorator      -> execution analytics (anonymous per-install
//                             counters; see ./analytics.ts).
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";

export const SelfHostPluginsProvider: Layer.Layer<PluginsProvider> = Layer.succeed(PluginsProvider)(
  {
    plugins: (context) =>
      executorConfig.plugins({
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
      }),
  },
);

export const SelfHostHostConfig: Layer.Layer<HostConfig> = Layer.sync(HostConfig, () => {
  const config = loadConfig();
  return {
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
    oauthDisableClientIdMetadataDocuments: config.oauthDisableClientIdMetadataDocuments,
    toolsSyncTtlMs: config.toolsSyncTtlMs,
    onIntegrationChange: (event) =>
      selfHostAnalytics.record(
        event.kind === "added" ? "integration_added" : "integration_removed",
        { plugin_key: event.pluginKey },
      ),
  };
});

export const SelfHostCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const { sandboxTimeoutMs } = loadConfig();
    return makeQuickJsExecutor(
      sandboxTimeoutMs === undefined ? {} : { timeoutMs: sandboxTimeoutMs },
    );
  },
);

/**
 * The `makeScopedExecutor` seams (`DbProvider` + `PluginsProvider` +
 * `HostConfig`) over the long-lived `SelfHostDb`. Shared between the production
 * `SelfHostExecutionStackLayer` and the `makeScopedExecutor` test entrypoint.
 */
export const SelfHostScopedExecutorSeams: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig,
  never,
  SelfHostDb
> = Layer.mergeAll(SelfHostDbProvider, SelfHostPluginsProvider, SelfHostHostConfig);

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer. Requires the long-lived `SelfHostDb` (provided once at
 * boot); the per-request executor only varies the scope stack.
 */
export const SelfHostExecutionStackLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator,
  never,
  SelfHostDb
> = Layer.mergeAll(
  SelfHostScopedExecutorSeams,
  SelfHostCodeExecutorProvider,
  SelfHostAnalyticsEngineDecorator,
);
