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
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { env } from "cloudflare:workers";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// Code substrate: when the Worker declares a `worker_loaders` LOADER binding,
// use the dynamic-worker executor (cloud's substrate) — real isolates with
// `globalOutbound: null`. Without the binding, fall back to QuickJS-wasm,
// which runs in a single Worker with no extra binding.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const loader = (env as { LOADER?: WorkerLoader }).LOADER;
    return loader ? makeDynamicWorkerExecutor({ loader }) : makeQuickJsExecutor();
  },
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

// Two stale catalogs rebuild at once, not the SDK's ten: each in-flight
// rebuild holds its resolved tools and schema definitions until its write
// commits, and a full fan-out over a few large OpenAPI specs overruns the
// 128MB Workers isolate. Writes are serialized anyway, so the narrower
// fan-out costs little convergence time.
const CLOUDFLARE_TOOLS_SYNC_CONCURRENCY = 2;

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
    toolsSyncConcurrency: CLOUDFLARE_TOOLS_SYNC_CONCURRENCY,
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
