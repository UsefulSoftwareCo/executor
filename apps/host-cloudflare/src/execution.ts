import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// QuickJS-wasm is the default code substrate because it runs in a single Worker
// with no extra binding. When Cloudflare's dynamic Worker Loader leaves closed
// beta, swap CodeExecutorProvider for the dynamic-worker executor (cloud's) —
// it's a one-Layer change behind this same seam.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => makeQuickJsExecutor(),
);

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) =>
      makeCloudflarePlugins(config.secretKey, {
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
        allowLocalNetwork: config.allowLocalNetwork,
      }),
  });

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
  });

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
    CloudflareCodeExecutorProvider,
    EngineDecoratorNoop,
  );
